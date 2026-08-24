import { statfs } from "node:fs/promises";
import { resolve } from "node:path";

import {
  addSkippedRepositoryChecks,
  bindLocalRepository,
  inspectGithub,
  inspectGithubRepository,
  inspectRegistry,
  inspectRepositoryPermissions,
  resolveDoctorTarget,
} from "./doctor/checks-github.js";
import {
  checkRuntime,
  checkTransmissionConfiguration,
  inspectConfig,
  inspectSqliteFeatures,
  inspectStorage,
} from "./doctor/checks-runtime.js";
import {
  inspectCanonicalState,
  inspectTransactions,
} from "./doctor/checks-canonical.js";
import { inspectSqliteProjection } from "./doctor/checks-projection.js";
import {
  DoctorReportBuilder,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorReport,
} from "./doctor/report-builder.js";
import { ExecaGitRemoteReader, type GitRemoteReader } from "./git-remote.js";
import type { GhRunnerLike } from "./gh-runner.js";
import {
  CliLlmSubscriptionInspector,
  type LlmSubscriptionInspectorLike,
} from "./subscription-cli-provider.js";

export type { DoctorCheck, DoctorCheckStatus, DoctorReport };

export interface DoctorRepositorySelection {
  readonly repo?: string;
  readonly workspacePath?: string;
}

export interface RepoKnowledgeDoctorLike {
  run(selection?: DoctorRepositorySelection): Promise<DoctorReport>;
}

export interface RepoKnowledgeDoctorOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly filesystemTypeReader?: (path: string) => Promise<bigint | number>;
  readonly ghRunner: GhRunnerLike;
  readonly gitRemoteReader?: GitRemoteReader;
  readonly llmSubscriptionInspector?: LlmSubscriptionInspectorLike;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly storageRoot: string;
}

/** Runs read-only installation, GitHub, canonical-state, and projection checks. */
export class RepoKnowledgeDoctor implements RepoKnowledgeDoctorLike {
  private readonly cwd: string;
  private readonly filesystemTypeReader: (
    path: string,
  ) => Promise<bigint | number>;
  private readonly ghRunner: GhRunnerLike;
  private readonly gitRemoteReader: GitRemoteReader;
  private readonly llmSubscriptionInspector: LlmSubscriptionInspectorLike;
  private readonly nodeVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly storageRoot: string;

  constructor(options: RepoKnowledgeDoctorOptions) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.filesystemTypeReader =
      options.filesystemTypeReader ??
      (async (path) => (await statfs(path, { bigint: true })).type);
    this.ghRunner = options.ghRunner;
    this.gitRemoteReader =
      options.gitRemoteReader ?? new ExecaGitRemoteReader();
    this.llmSubscriptionInspector =
      options.llmSubscriptionInspector ??
      new CliLlmSubscriptionInspector({
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      });
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.platform = options.platform ?? process.platform;
    this.storageRoot = resolve(options.storageRoot);
  }

  async run(selection: DoctorRepositorySelection = {}): Promise<DoctorReport> {
    const report = new DoctorReportBuilder();
    checkRuntime(report, this.nodeVersion, this.platform);
    const storageExists = await inspectStorage(
      report,
      this.storageRoot,
      this.filesystemTypeReader,
    );
    const config = storageExists
      ? await inspectConfig(report, this.storageRoot)
      : null;
    await checkTransmissionConfiguration(
      report,
      config,
      this.llmSubscriptionInspector,
    );
    await inspectSqliteFeatures(report);
    const github = await inspectGithub(report, this.ghRunner);
    const registry = storageExists
      ? await inspectRegistry(report, this.storageRoot)
      : null;
    const target = await resolveDoctorTarget(report, selection, config, {
      cwd: this.cwd,
      gitRemoteReader: this.gitRemoteReader,
    });
    const identity = await inspectGithubRepository(
      report,
      this.ghRunner,
      github,
      target,
    );
    const local = bindLocalRepository(
      report,
      registry,
      target,
      identity,
      this.storageRoot,
    );
    if (local === null) {
      addSkippedRepositoryChecks(report);
      return report.build();
    }

    await inspectRepositoryPermissions(report, local.absolutePath);
    await inspectTransactions(report, local.absolutePath, local.currentName);
    const canonical = await inspectCanonicalState(
      report,
      local.absolutePath,
      local.repoId,
      local.currentName,
    );
    await inspectSqliteProjection(
      report,
      local.absolutePath,
      canonical,
      local.repoId,
      local.currentName,
    );
    return report.build();
  }
}
