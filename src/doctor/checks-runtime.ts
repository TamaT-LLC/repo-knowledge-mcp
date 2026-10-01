import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  DEFAULT_CONFIG_FILE_NAME,
  loadRepoKnowledgeConfig,
  resolveRepositoryPolicy,
} from "../config.js";
import type { RepoKnowledgeConfig } from "../domain-schemas.js";
import type { ResolvedTypeSafeCredential } from "../jev-client.js";
import { getLlmProviderDefinition } from "../llm-provider-config.js";
import type { LlmSubscriptionInspectorLike } from "../subscription-cli-provider.js";
import { DoctorReportBuilder, type DoctorCheck } from "./report-builder.js";
import {
  errorCode,
  errorMessage,
  isSupportedNodeVersion,
  octal,
  unsignedFilesystemType,
} from "./util.js";

const NETWORK_FILESYSTEM_TYPES = new Map<number, string>([
  [0x0000_6969, "NFS"],
  [0x0000_517b, "SMB"],
  [0xff53_4d42, "CIFS"],
  [0xfe53_4d42, "SMB2"],
  [0x5346_414f, "AFS"],
  [0x0102_1997, "9P"],
]);
const SYNCHRONIZED_PATH =
  /(?:^|[/\\])(?:Dropbox|Google Drive|Mobile Documents|OneDrive)(?:[/\\]|$)/iu;

/** Reports whether the supplied Node.js version and operating system are supported. */
export function checkRuntime(
  report: DoctorReportBuilder,
  nodeVersion: string,
  platform: NodeJS.Platform,
): void {
  const supportedNode = isSupportedNodeVersion(nodeVersion);
  report.add(
    supportedNode
      ? {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js version is supported.",
          status: "pass",
        }
      : {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js must be 22.13 or newer in the 22 line, or 24+.",
          remedy: "Install a supported Node.js release and rerun doctor.",
          status: "fail",
        },
  );
  const supportedPlatform = platform === "darwin" || platform === "linux";
  report.add(
    supportedPlatform
      ? {
          details: { platform },
          id: "runtime.os",
          message: "Operating system is supported by the M1 storage model.",
          status: "pass",
        }
      : {
          details: { platform },
          id: "runtime.os",
          message: "M1 supports only macOS and Linux.",
          remedy: "Use repo-knowledge on macOS or Linux.",
          status: "fail",
        },
  );
}

/** Checks route readiness using repository consent, or explicitly labeled global defaults. */
export async function checkTransmissionConfiguration(
  report: DoctorReportBuilder,
  config: RepoKnowledgeConfig | null,
  subscriptionInspector: LlmSubscriptionInspectorLike,
  typesafeCredential: ResolvedTypeSafeCredential | null = null,
  repository: string | null = null,
): Promise<void> {
  if (config === null) {
    for (const id of [
      "config.provider_transmission",
      "config.merge_classifier_transmission",
      "config.host_assisted_transmission",
    ]) {
      report.add({
        id,
        message:
          "Transmission consent could not be checked without valid config.",
        status: "warn",
      });
    }
    return;
  }
  const policy =
    repository === null
      ? {
          allowCloudTransmission: config.llm.allowCloudTransmission,
          allowCloudMergeClassification:
            config.mergeClassifier.allowCloudTransmission,
        }
      : resolveRepositoryPolicy(config, repository);
  const overrides =
    repository === null ? undefined : config.repoPolicies[repository];
  const addProvider = transmissionCheckReporter(report, repository, {
    global_consent: config.llm.allowCloudTransmission,
    repository_override: overrides?.allowCloudTransmission ?? null,
    effective_consent: policy.allowCloudTransmission,
    enabled: config.llm.mode !== "disabled" && policy.allowCloudTransmission,
  });
  const addMergeClassifier = transmissionCheckReporter(report, repository, {
    global_consent: config.mergeClassifier.allowCloudTransmission,
    repository_override: overrides?.allowCloudMergeClassification ?? null,
    effective_consent: policy.allowCloudMergeClassification,
    enabled:
      config.mergeClassifier.mode === "jev" &&
      policy.allowCloudMergeClassification,
  });
  const mergeClassifier = config.mergeClassifier;
  if (
    mergeClassifier.mode === "provider" &&
    policy.allowCloudMergeClassification
  ) {
    addMergeClassifier({
      id: "config.merge_classifier_transmission",
      message:
        "Jev cloud consent is true while the provider merge classifier is selected.",
      remedy:
        "Set the applicable repoPolicies.<owner/name>.allowCloudMergeClassification or global mergeClassifier.allowCloudTransmission to false, or select Jev intentionally.",
      status: "warn",
    });
  } else if (
    mergeClassifier.mode === "jev" &&
    !policy.allowCloudMergeClassification
  ) {
    addMergeClassifier({
      id: "config.merge_classifier_transmission",
      message:
        "Jev merge classification is configured but cloud transmission consent is false.",
      remedy:
        "Use provider mode, or review the applicable repoPolicies.<owner/name>.allowCloudMergeClassification override and global mergeClassifier.allowCloudTransmission consent.",
      status: "warn",
    });
  } else if (mergeClassifier.mode === "jev" && typesafeCredential === null) {
    addMergeClassifier({
      id: "config.merge_classifier_transmission",
      message: "Jev merge classification has no TypeSafe API credential.",
      remedy:
        "Set TYPESAFE_API_KEY or save the credential in the macOS Keychain, then rerun doctor.",
      status: "fail",
    });
  } else {
    addMergeClassifier({
      details:
        mergeClassifier.mode === "jev"
          ? {
              credential: typesafeCredential?.source,
              minimum_same_confidence: mergeClassifier.minimumSameConfidence,
              model: mergeClassifier.model,
            }
          : { mode: "provider" },
      id: "config.merge_classifier_transmission",
      message:
        mergeClassifier.mode === "jev"
          ? "Jev merge classification has explicit consent, model, and API credential."
          : "Jev merge classification is safely disabled.",
      status: "pass",
    });
  }

  const provider = config.llm;
  if (provider.mode === "disabled" && policy.allowCloudTransmission) {
    addProvider({
      id: "config.provider_transmission",
      message:
        "Cloud transmission consent is true while the provider mode is disabled.",
      remedy:
        "Set the applicable repoPolicies.<owner/name>.allowCloudTransmission or global llm.allowCloudTransmission to false, or configure mode and model intentionally.",
      status: "warn",
    });
  } else if (provider.mode !== "disabled" && !policy.allowCloudTransmission) {
    const definition = getLlmProviderDefinition(provider.mode);
    addProvider({
      id: "config.provider_transmission",
      message: `${definition.displayName} mode is configured but cloud transmission consent is false; provider calls remain disabled.`,
      remedy:
        "Either set mode to disabled, or review the applicable repoPolicies.<owner/name>.allowCloudTransmission override and global llm.allowCloudTransmission consent.",
      status: "warn",
    });
  } else if (
    provider.mode !== "disabled" &&
    policy.allowCloudTransmission &&
    provider.model === null
  ) {
    const definition = getLlmProviderDefinition(provider.mode);
    addProvider({
      id: "config.provider_transmission",
      message: `Enabled ${definition.displayName} transmission has no configured model.`,
      remedy: "Set llm.model before running provider distillation.",
      status: "fail",
    });
  } else if (provider.mode !== "disabled") {
    const definition = getLlmProviderDefinition(provider.mode);
    const subscription = await subscriptionInspector.inspect(provider.mode);
    if (!subscription.cliAvailable) {
      addProvider({
        id: "config.provider_transmission",
        message: `Enabled ${definition.displayName} transmission cannot find the ${definition.cliExecutable} CLI.`,
        remedy: `Install ${definition.displayName}, then run ${definition.loginCommand}.`,
        status: "fail",
      });
    } else if (!subscription.authenticated) {
      addProvider({
        id: "config.provider_transmission",
        message: `Enabled ${definition.displayName} transmission has no usable subscription login.`,
        remedy: `Run ${definition.loginCommand} and choose subscription sign-in, then rerun doctor.`,
        status: "fail",
      });
    } else {
      addProvider({
        details: {
          authentication: subscription.method ?? "subscription",
          cli: definition.cliExecutable,
        },
        id: "config.provider_transmission",
        message: `${definition.displayName} mode, model, consent, and subscription login are coherent.`,
        status: "pass",
      });
    }
  } else {
    addProvider({
      id: "config.provider_transmission",
      message: "Provider transmission is safely disabled.",
      status: "pass",
    });
  }

  const host = config.hostAssistedDistillation;
  /** Annotates host-assisted diagnostics with their storage-wide consent scope. */
  const addHost = (check: DoctorCheck): void =>
    report.add({
      ...check,
      details: {
        global_only: true,
        enabled: host.enabled && host.allowReviewContentTransmission,
      },
      message: `${check.message} Host-assisted consent is global-only for all repositories sharing this storage, including future repositories; there is no repository override. External-distillation opt-out does not disable normal approved-rule outputs to a connected MCP client.`,
    });
  if (host.enabled !== host.allowReviewContentTransmission) {
    addHost({
      id: "config.host_assisted_transmission",
      message:
        "Host-assisted mode requires both enabled and allowReviewContentTransmission; review content remains unavailable.",
      remedy:
        "Set both host-assisted consent fields to false, or intentionally enable both after reviewing disclosure.",
      status: "warn",
    });
  } else {
    addHost({
      id: "config.host_assisted_transmission",
      message: host.enabled
        ? "Host-assisted transmission has both required opt-ins."
        : "Host-assisted transmission is safely disabled.",
      status: "pass",
    });
  }
}

/** Adds consent provenance and the evaluated repository scope to a diagnostic check. */
function transmissionCheckReporter(
  report: DoctorReportBuilder,
  repository: string | null,
  policy: {
    readonly global_consent: boolean;
    readonly repository_override: boolean | null;
    readonly effective_consent: boolean;
    readonly enabled: boolean;
  },
): (check: DoctorCheck) => void {
  return (check) =>
    report.add({
      ...check,
      details: { ...check.details, ...policy, repository },
      message:
        check.message +
        (repository === null
          ? " Global defaults only; no repository policy was evaluated."
          : ` Repository ${repository}: global consent ${String(policy.global_consent)}, repository override ${policy.repository_override === null ? "inherit" : String(policy.repository_override)}, effective consent ${String(policy.effective_consent)}.`),
    });
}

export async function inspectSqliteFeatures(
  report: DoctorReportBuilder,
): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(
      "CREATE VIRTUAL TABLE doctor_fts USING fts5(value, tokenize='trigram')",
    );
    database.prepare("INSERT INTO doctor_fts(value) VALUES (?)").run("doctor");
    const row = database
      .prepare(
        "SELECT count(*) AS count FROM doctor_fts WHERE doctor_fts MATCH ?",
      )
      .get('"doctor"') as { count: number };
    if (row.count !== 1) throw new Error("trigram query returned no row");
    report.add({
      id: "sqlite.features",
      message: "SQLite FTS5 and the trigram tokenizer are available.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.features",
      message: "SQLite FTS5 or the trigram tokenizer is unavailable.",
      remedy:
        "Use the supported prebuilt better-sqlite3 runtime for this Node.js version.",
      status: "fail",
    });
  } finally {
    database.close();
  }
}

export async function inspectStorage(
  report: DoctorReportBuilder,
  storageRoot: string,
  filesystemTypeReader: (path: string) => Promise<bigint | number>,
): Promise<boolean> {
  let metadata: Stats;
  try {
    metadata = await lstat(storageRoot);
  } catch (error) {
    report.add({
      id: "storage.permissions",
      message: "Storage root does not exist or cannot be inspected.",
      path: storageRoot,
      remedy:
        "Run a normal repo-knowledge setup command to create private storage, then rerun doctor.",
      status: "fail",
      details: { error: errorCode(error) },
    });
    report.add({
      id: "storage.local_filesystem",
      message: "Local-filesystem support could not be checked without storage.",
      path: storageRoot,
      status: "warn",
    });
    return false;
  }
  const permission = metadata.mode & 0o777;
  const privateDirectory =
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    permission === 0o700;
  report.add(
    privateDirectory
      ? {
          id: "storage.permissions",
          message: "Storage root is a real directory with mode 700.",
          path: storageRoot,
          status: "pass",
        }
      : {
          details: { mode: octal(permission) },
          id: "storage.permissions",
          message:
            "Storage root must be a non-symlink directory with mode 700.",
          path: storageRoot,
          remedy: `Move storage to a private directory and run chmod 700 ${storageRoot}.`,
          status: "fail",
        },
  );

  if (SYNCHRONIZED_PATH.test(storageRoot)) {
    report.add({
      id: "storage.local_filesystem",
      message: "Storage appears to be inside a synchronized filesystem path.",
      path: storageRoot,
      remedy:
        "Move REPO_KNOWLEDGE_HOME to a local, non-synchronized filesystem.",
      status: "fail",
    });
    return true;
  }
  try {
    const type = unsignedFilesystemType(
      await filesystemTypeReader(storageRoot),
    );
    const networkName = NETWORK_FILESYSTEM_TYPES.get(type);
    report.add(
      networkName === undefined
        ? {
            details: { filesystem_type: `0x${type.toString(16)}` },
            id: "storage.local_filesystem",
            message:
              "Storage is not on a recognized network filesystem or sync path.",
            path: storageRoot,
            status: "pass",
          }
        : {
            details: { filesystem: networkName },
            id: "storage.local_filesystem",
            message: `${networkName} storage is outside the M1 durability guarantee.`,
            path: storageRoot,
            remedy:
              "Move REPO_KNOWLEDGE_HOME to a local filesystem before writing canonical state.",
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "storage.local_filesystem",
      message: "Filesystem type could not be determined.",
      path: storageRoot,
      remedy:
        "Confirm manually that storage is local and not NFS, SMB, Dropbox, iCloud, or another sync area.",
      status: "warn",
    });
  }
  return true;
}

export async function inspectConfig(
  report: DoctorReportBuilder,
  storageRoot: string,
): Promise<RepoKnowledgeConfig | null> {
  const configPath = join(storageRoot, DEFAULT_CONFIG_FILE_NAME);
  let config: RepoKnowledgeConfig;
  try {
    config = await loadRepoKnowledgeConfig(configPath);
    report.add({
      id: "config.syntax",
      message: "Configuration is valid and uses the supported schema.",
      path: configPath,
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "config.syntax",
      message: "Configuration could not be parsed safely.",
      path: configPath,
      remedy: `Fix ${configPath}; doctor does not rewrite invalid configuration.`,
      status: "fail",
    });
    report.add({
      id: "config.permissions",
      message: "Config permissions were not trusted because parsing failed.",
      path: configPath,
      status: "warn",
    });
    return null;
  }
  try {
    const metadata = await lstat(configPath);
    const permission = metadata.mode & 0o777;
    const valid =
      metadata.isFile() && !metadata.isSymbolicLink() && permission === 0o600;
    report.add(
      valid
        ? {
            id: "config.permissions",
            message: "Config is a regular file with mode 600.",
            path: configPath,
            status: "pass",
          }
        : {
            details: { mode: octal(permission) },
            id: "config.permissions",
            message: "Config must be a non-symlink regular file with mode 600.",
            path: configPath,
            remedy: `Replace any symlink and run chmod 600 ${configPath}.`,
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "config.permissions",
      message: "Config permissions could not be inspected.",
      path: configPath,
      status: "fail",
    });
  }
  return config;
}
