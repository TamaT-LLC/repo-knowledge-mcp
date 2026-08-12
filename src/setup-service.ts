import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import type { InitializedStorage } from "./config.js";
import type { DoctorReport } from "./doctor-service.js";
import type {
  CommentObservation,
  RepoKnowledgeConfig,
} from "./domain-schemas.js";
import type { RepositoryResolution } from "./repository-resolver.js";
import type { SetupState, SetupStateStore } from "./setup-state-store.js";
import type { SyncCheckpoint } from "./sync-checkpoint-store.js";
import type { SyncRepoSummary } from "./sync-repo-service.js";
import type { CliRedistillResult } from "./cli.js";
import type { TerminalActivityUpdate } from "./terminal-progress.js";

export const DEFAULT_SETUP_LOOKBACK_DAYS = 90;
const ALL_HISTORY_SYNC_BOUNDARY = "1970-01-01T00:00:00.000Z";

export interface GuidedSetupRequest {
  readonly allHistory?: boolean;
  readonly repo?: string;
  readonly since?: string;
  readonly workspacePath?: string;
}

export interface SetupConfirmationRequest {
  readonly defaultValue: boolean;
  readonly id: string;
  readonly message: string;
}

export interface SetupTextInputRequest {
  readonly id: string;
  readonly message: string;
}

export interface GuidedSetupPrompt {
  confirm(request: SetupConfirmationRequest): Promise<boolean>;
  input?(request: SetupTextInputRequest): Promise<string>;
  progress?(update: TerminalActivityUpdate): void;
}

export interface SetupTrustCandidate {
  readonly actorId: string;
  readonly alreadyTrusted: boolean;
  readonly commentCount: number;
  readonly login: string;
}

export interface GuidedSetupResult {
  readonly config_path: string;
  readonly doctor: DoctorReport["summary"];
  readonly initial_sync: {
    readonly scope: {
      readonly mode: "all-history" | "since";
      readonly since: string | null;
    };
    readonly summary: SyncRepoSummary;
  };
  readonly repository: {
    readonly id: string;
    readonly name: string;
    readonly storage_path: string;
    readonly workspace_path: string | null;
  };
  readonly resumed: boolean;
  readonly state_path: string;
  readonly storage_root: string;
  readonly transmission: {
    readonly host_assisted: boolean;
    readonly provider: boolean;
  };
  readonly trust: {
    readonly candidates: number;
    readonly selected: readonly {
      readonly actor_id: string;
      readonly login: string;
    }[];
  };
}

export interface GuidedSetupDependencies {
  readonly clock?: () => Date;
  initializeStorage(): Promise<InitializedStorage>;
  prepareRepository(repository: RepositoryResolution): Promise<void>;
  readTrustCandidates(
    repository: RepositoryResolution,
    config: RepoKnowledgeConfig,
  ): Promise<readonly SetupTrustCandidate[]>;
  redistill(repository: RepositoryResolution): Promise<CliRedistillResult>;
  readSyncCheckpoint(
    repository: RepositoryResolution,
  ): Promise<SyncCheckpoint | null>;
  resolveRepository(
    request: GuidedSetupRequest,
    config: RepoKnowledgeConfig,
  ): Promise<RepositoryResolution>;
  runDoctor(repository: RepositoryResolution): Promise<DoctorReport>;
  stateStore(repository: RepositoryResolution): SetupStateStore;
  sync(
    repository: RepositoryResolution,
    request: { readonly since?: string },
  ): Promise<SyncRepoSummary>;
  updateConfig(
    configPath: string,
    update: (current: RepoKnowledgeConfig) => unknown,
  ): Promise<RepoKnowledgeConfig>;
}

export type GuidedSetupErrorCode =
  | "SETUP_CONFIG_CONFLICT"
  | "SETUP_DOCTOR_FAILED"
  | "SETUP_PREPARATION_FAILED"
  | "SETUP_PROVIDER_MODEL_REQUIRED"
  | "SETUP_REPOSITORY_MISMATCH"
  | "SETUP_RESUME_SCOPE_MISMATCH"
  | "SETUP_STATE_MISMATCH"
  | "SETUP_SYNC_FAILED";

export class GuidedSetupError extends Error {
  constructor(
    readonly code: GuidedSetupErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "GuidedSetupError";
  }
}

/** Coordinates one safe, resumable personal setup session. */
export class GuidedSetupService {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: GuidedSetupDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async run(
    request: GuidedSetupRequest,
    prompt: GuidedSetupPrompt,
  ): Promise<GuidedSetupResult> {
    const resolution = await runSetupActivity(
      prompt,
      "setup.resolve",
      "Resolving repository and private storage",
      async () => {
        const storage = await this.dependencies.initializeStorage();
        const repository = await this.dependencies.resolveRepository(
          request,
          storage.config,
        );
        const stateStore = this.dependencies.stateStore(repository);
        const state = await stateStore.read();
        assertStateMatches(state, repository, request);
        return { repository, state, stateStore, storage };
      },
    );
    const { repository, stateStore, storage } = resolution;
    let state = resolution.state;
    const resumed = state !== null;
    const initialSince =
      state?.initial_since ?? initialSinceFor(request, this.clock());
    const initialConfig = storage.config;
    const transmission =
      state === null
        ? await chooseTransmission(initialConfig, prompt)
        : configuredTransmission(initialConfig);

    let configBeforeSetup = initialConfig;
    let config = await this.dependencies.updateConfig(
      storage.configPath,
      (current) => {
        configBeforeSetup = current;
        return setupConfig(current, repository, transmission);
      },
    );
    await runSetupActivity(
      prompt,
      "setup.prepare",
      "Preparing the local repository store",
      async () => {
        try {
          await this.dependencies.prepareRepository(repository);
        } catch (error) {
          await rollbackConfig(
            this.dependencies,
            storage.configPath,
            config,
            configBeforeSetup,
          );
          throw new GuidedSetupError(
            "SETUP_PREPARATION_FAILED",
            "repository preparation failed; config changes were rolled back",
            {},
            { cause: error },
          );
        }
      },
    );
    try {
      await runSetupActivity(
        prompt,
        "setup.preflight",
        "Running preflight health checks",
        async () => {
          const report = await this.dependencies.runDoctor(repository);
          if (!report.ok) {
            throw new GuidedSetupError(
              "SETUP_DOCTOR_FAILED",
              doctorFailureMessage(
                report,
                "doctor failed before initial sync; config changes were rolled back",
              ),
              { checks: report.checks, summary: report.summary },
            );
          }
          return report;
        },
      );
    } catch (error) {
      await rollbackConfig(
        this.dependencies,
        storage.configPath,
        config,
        configBeforeSetup,
      );
      if (error instanceof GuidedSetupError) throw error;
      throw new GuidedSetupError(
        "SETUP_DOCTOR_FAILED",
        "doctor could not complete before initial sync; config changes were rolled back",
        {},
        { cause: error },
      );
    }

    const now = this.clock().toISOString();
    state ??= {
      created_at: now,
      initial_since: initialSince,
      phase: "configured",
      repo_id: repository.repoId,
      repository: repository.currentName,
      schema_version: 1,
      updated_at: now,
      workspace_path: repository.workspacePath ?? null,
    };
    state = await stateStore.write({
      ...state,
      repository: repository.currentName,
      updated_at: now,
      workspace_path: repository.workspacePath ?? state.workspace_path,
    });
    const configuredState = state;

    const syncSummary = await runSetupActivity(
      prompt,
      "setup.sync",
      "Syncing pull request reviews",
      async () => {
        const checkpoint =
          await this.dependencies.readSyncCheckpoint(repository);
        const syncRequest = initialSyncRequest(
          configuredState,
          checkpoint,
          resumed,
        );
        const summary = await this.dependencies.sync(repository, syncRequest);
        if (summary.failed > 0) {
          throw new GuidedSetupError(
            "SETUP_SYNC_FAILED",
            "initial sync was partial; rerun setup to resume from the durable checkpoint",
            { summary },
          );
        }
        return summary;
      },
    );
    state = await stateStore.write({
      ...state,
      phase: state.phase === "configured" ? "synced" : state.phase,
      updated_at: this.clock().toISOString(),
    });

    const candidates = await runSetupActivity(
      prompt,
      "setup.trust",
      "Finding human reviewer trust candidates",
      () => this.dependencies.readTrustCandidates(repository, config),
    );
    const selected: SetupTrustCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.alreadyTrusted) continue;
      if (
        await prompt.confirm({
          defaultValue: false,
          id: `trust.${candidate.actorId}`,
          message:
            `Trust human reviewer ${candidate.login} (${candidate.actorId}, ` +
            `${String(candidate.commentCount)} observed comment(s))?`,
        })
      ) {
        selected.push(candidate);
      }
    }

    let configBeforeTrust = config;
    if (selected.length > 0) {
      config = await this.dependencies.updateConfig(
        storage.configPath,
        (current) => {
          configBeforeTrust = current;
          return {
            ...current,
            trust: {
              ...current.trust,
              trustedActorIds: sortAndDedupeStrings([
                ...current.trust.trustedActorIds,
                ...selected.map((candidate) => candidate.actorId),
              ]),
              trustedLogins: sortAndDedupeStrings([
                ...current.trust.trustedLogins,
                ...selected.map((candidate) => candidate.login),
              ]),
            },
          };
        },
      );
    }
    const shouldRedistill =
      state.phase === "trust-configured" ||
      selected.length > 0 ||
      (state.phase === "synced" &&
        candidates.some((candidate) => candidate.alreadyTrusted));
    if (shouldRedistill) {
      state = await stateStore.write({
        ...state,
        phase: "trust-configured",
        updated_at: this.clock().toISOString(),
      });
      await runSetupActivity(
        prompt,
        "setup.redistill",
        "Queuing review knowledge with updated trust",
        () => this.dependencies.redistill(repository),
      );
    }

    let finalDoctor: DoctorReport;
    try {
      finalDoctor = await runSetupActivity(
        prompt,
        "setup.doctor",
        "Running final health checks",
        async () => {
          const report = await this.dependencies.runDoctor(repository);
          if (!report.ok) {
            throw new GuidedSetupError(
              "SETUP_DOCTOR_FAILED",
              doctorFailureMessage(
                report,
                "doctor failed after setup; newly selected trust settings were rolled back",
              ),
              { checks: report.checks, summary: report.summary },
            );
          }
          return report;
        },
      );
    } catch (error) {
      await rollbackSelectedTrust({
        configAfterTrust: config,
        configBeforeTrust,
        dependencies: this.dependencies,
        selected,
        state,
        stateStore,
        storageConfigPath: storage.configPath,
        updatedAt: this.clock().toISOString(),
      });
      if (error instanceof GuidedSetupError) throw error;
      throw new GuidedSetupError(
        "SETUP_DOCTOR_FAILED",
        "doctor could not complete after setup; newly selected trust settings were rolled back",
        {},
        { cause: error },
      );
    }
    state = await stateStore.write({
      ...state,
      phase: "complete",
      updated_at: this.clock().toISOString(),
    });

    return {
      config_path: storage.configPath,
      doctor: finalDoctor.summary,
      initial_sync: {
        scope: {
          mode: state.initial_since === null ? "all-history" : "since",
          since: state.initial_since,
        },
        summary: syncSummary,
      },
      repository: {
        id: repository.repoId,
        name: repository.currentName,
        storage_path: repository.absolutePath,
        workspace_path: repository.workspacePath ?? null,
      },
      resumed,
      state_path: stateStore.path,
      storage_root: storage.rootPath,
      transmission: transmissionState(config),
      trust: {
        candidates: candidates.length,
        selected: selected.map((candidate) => ({
          actor_id: candidate.actorId,
          login: candidate.login,
        })),
      },
    };
  }
}

async function runSetupActivity<Result>(
  prompt: GuidedSetupPrompt,
  id: string,
  label: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  prompt.progress?.({ id, label, state: "started" });
  try {
    const result = await operation();
    prompt.progress?.({ id, label, state: "succeeded" });
    return result;
  } catch (error) {
    prompt.progress?.({ id, label, state: "failed" });
    throw error;
  }
}

/** Selects only unambiguous, non-external human identities. */
export function collectSetupTrustCandidates(
  comments: readonly CommentObservation[],
  config: RepoKnowledgeConfig,
): readonly SetupTrustCandidate[] {
  const humans = comments.filter(isSetupHumanObservation);
  const actorsByLogin = new Map<string, Set<string>>();
  for (const comment of humans) {
    const actorId = comment.actor.actor_id!;
    const login = comment.actor.login!;
    addSetValue(actorsByLogin, login, actorId);
  }

  const observationsByActor = new Map<
    string,
    Array<{ login: string; observedAt: string; updatedAt: string }>
  >();
  for (const comment of humans) {
    const actorId = comment.actor.actor_id!;
    const login = comment.actor.login!;
    if (actorsByLogin.get(login)?.size !== 1) continue;
    const observations = observationsByActor.get(actorId) ?? [];
    observations.push({
      login,
      observedAt: comment.observed_at,
      updatedAt: comment.updated_at,
    });
    observationsByActor.set(actorId, observations);
  }
  return [...observationsByActor.entries()]
    .map(([actorId, observations]): SetupTrustCandidate => {
      const aliases = sortAndDedupeStrings(
        observations.map((observation) => observation.login),
      );
      const current = [...observations].sort(compareHumanObservations).at(-1)!;
      return {
        actorId,
        alreadyTrusted:
          config.trust.trustedActorIds.includes(actorId) ||
          aliases.some((login) => config.trust.trustedLogins.includes(login)),
        commentCount: observations.length,
        login: current.login,
      };
    })
    .sort(
      (left, right) =>
        right.commentCount - left.commentCount ||
        compareCodeUnits(left.login, right.login) ||
        compareCodeUnits(left.actorId, right.actorId),
    );
}

function isSetupHumanObservation(comment: CommentObservation): boolean {
  const actor = comment.actor;
  return (
    actor.actor_kind === "user" &&
    actor.provider === "human" &&
    actor.actor_id !== undefined &&
    actor.login !== null &&
    actor.author_association !== undefined &&
    !actor.login.toLocaleLowerCase("en-US").endsWith("[bot]") &&
    !isExternalAssociation(actor.author_association)
  );
}

function compareHumanObservations(
  left: {
    readonly login: string;
    readonly observedAt: string;
    readonly updatedAt: string;
  },
  right: {
    readonly login: string;
    readonly observedAt: string;
    readonly updatedAt: string;
  },
): number {
  return (
    compareCodeUnits(left.observedAt, right.observedAt) ||
    compareCodeUnits(left.updatedAt, right.updatedAt) ||
    compareCodeUnits(left.login, right.login)
  );
}

function initialSinceFor(
  request: GuidedSetupRequest,
  now: Date,
): string | null {
  if (request.allHistory === true) return null;
  if (request.since !== undefined) return request.since;
  return new Date(
    now.getTime() - DEFAULT_SETUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

function initialSyncRequest(
  state: SetupState,
  checkpoint: SyncCheckpoint | null,
  resumed: boolean,
): { readonly since?: string } {
  if (checkpoint === null) {
    return state.initial_since === null ? {} : { since: state.initial_since };
  }
  if (resumed) return {};
  if (state.initial_since !== null) {
    return Date.parse(state.initial_since) <
      Date.parse(checkpoint.cursor.last_updated_at)
      ? { since: state.initial_since }
      : {};
  }
  return {
    since: ALL_HISTORY_SYNC_BOUNDARY,
  };
}

async function chooseTransmission(
  config: RepoKnowledgeConfig,
  prompt: GuidedSetupPrompt,
): Promise<{
  readonly hostAssisted: boolean;
  readonly provider: boolean;
  readonly providerModel: string | null;
}> {
  const current = configuredTransmission(config);
  const provider =
    current.provider ||
    (await prompt.confirm({
      defaultValue: false,
      id: "transmission.provider",
      message:
        "Provider route sends review comment bodies and diff hunks to Anthropic and requires ANTHROPIC_API_KEY plus llm.model. Enable it?",
    }));
  const providerModel = provider
    ? (config.llm.model ?? (await readProviderModel(prompt)))
    : config.llm.model;
  const hostAssisted =
    current.hostAssisted ||
    (await prompt.confirm({
      defaultValue: false,
      id: "transmission.host-assisted",
      message:
        "Host-assisted route returns review comment bodies to the connected MCP host model. Enable it?",
    }));
  return { hostAssisted, provider, providerModel };
}

async function readProviderModel(prompt: GuidedSetupPrompt): Promise<string> {
  if (prompt.input === undefined) {
    throw new GuidedSetupError(
      "SETUP_PROVIDER_MODEL_REQUIRED",
      "provider opt-in requires an Anthropic model ID input",
    );
  }
  for (;;) {
    const model = (
      await prompt.input({
        id: "transmission.provider-model",
        message: "Anthropic model ID",
      })
    ).trim();
    if (model.length > 0) return model;
  }
}

function setupConfig(
  current: RepoKnowledgeConfig,
  repository: RepositoryResolution,
  transmission: {
    readonly hostAssisted: boolean;
    readonly provider: boolean;
    readonly providerModel?: string | null;
  },
): unknown {
  const workspacePath = repository.workspacePath;
  if (workspacePath !== undefined) {
    const mapped = current.workspaceMappings[workspacePath];
    if (
      mapped !== undefined &&
      mapped.toLocaleLowerCase("en-US") !==
        repository.currentName.toLocaleLowerCase("en-US")
    ) {
      throw new GuidedSetupError(
        "SETUP_REPOSITORY_MISMATCH",
        `workspace ${workspacePath} is already mapped to ${mapped}`,
        { requested: repository.currentName, workspace: workspacePath },
      );
    }
  }
  return {
    ...current,
    defaultRepo: current.defaultRepo ?? repository.currentName,
    hostAssistedDistillation: {
      ...current.hostAssistedDistillation,
      ...(transmission.hostAssisted
        ? { allowReviewContentTransmission: true, enabled: true }
        : {}),
    },
    llm: {
      ...current.llm,
      ...(transmission.provider
        ? {
            allowCloudTransmission: true,
            mode: "anthropic",
            model: transmission.providerModel ?? current.llm.model,
          }
        : {}),
    },
    repos: sortAndDedupeStrings([...current.repos, repository.currentName]),
    workspaceMappings:
      workspacePath === undefined
        ? current.workspaceMappings
        : {
            ...current.workspaceMappings,
            [workspacePath]: repository.currentName,
          },
  };
}

function configuredTransmission(config: RepoKnowledgeConfig): {
  readonly hostAssisted: boolean;
  readonly provider: boolean;
} {
  return {
    hostAssisted:
      config.hostAssistedDistillation.enabled &&
      config.hostAssistedDistillation.allowReviewContentTransmission,
    provider:
      config.llm.mode !== "disabled" && config.llm.allowCloudTransmission,
  };
}

function transmissionState(config: RepoKnowledgeConfig): {
  readonly host_assisted: boolean;
  readonly provider: boolean;
} {
  const transmission = configuredTransmission(config);
  return {
    host_assisted: transmission.hostAssisted,
    provider: transmission.provider,
  };
}

function assertStateMatches(
  state: SetupState | null,
  repository: RepositoryResolution,
  request: GuidedSetupRequest,
): void {
  if (state === null) return;
  if (state.repo_id !== repository.repoId) {
    throw new GuidedSetupError(
      "SETUP_STATE_MISMATCH",
      "setup state belongs to another repository identity",
      { actual: state.repo_id, expected: repository.repoId },
    );
  }
  if (request.allHistory === true && state.initial_since !== null) {
    throw scopeMismatch(state.initial_since, null);
  }
  if (request.since !== undefined && request.since !== state.initial_since) {
    throw scopeMismatch(state.initial_since, request.since);
  }
}

function scopeMismatch(
  persisted: string | null,
  requested: string | null,
): GuidedSetupError {
  return new GuidedSetupError(
    "SETUP_RESUME_SCOPE_MISMATCH",
    "an interrupted setup must resume with its original initial-sync scope",
    { persisted, requested },
  );
}

function configsEqual(
  left: RepoKnowledgeConfig,
  right: RepoKnowledgeConfig,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

async function rollbackConfig(
  dependencies: GuidedSetupDependencies,
  configPath: string,
  current: RepoKnowledgeConfig,
  original: RepoKnowledgeConfig,
): Promise<void> {
  if (configsEqual(current, original)) return;
  await dependencies.updateConfig(configPath, (latest) => {
    assertConfigUnchanged(latest, current, "setup rollback");
    return original;
  });
}

async function rollbackSelectedTrust(options: {
  readonly configAfterTrust: RepoKnowledgeConfig;
  readonly configBeforeTrust: RepoKnowledgeConfig;
  readonly dependencies: GuidedSetupDependencies;
  readonly selected: readonly SetupTrustCandidate[];
  readonly state: SetupState;
  readonly stateStore: SetupStateStore;
  readonly storageConfigPath: string;
  readonly updatedAt: string;
}): Promise<void> {
  if (options.selected.length === 0) return;
  await options.dependencies.updateConfig(
    options.storageConfigPath,
    (latest) => {
      assertConfigUnchanged(latest, options.configAfterTrust, "trust rollback");
      return options.configBeforeTrust;
    },
  );
  await options.stateStore.write({
    ...options.state,
    phase: "synced",
    updated_at: options.updatedAt,
  });
}

function assertConfigUnchanged(
  actual: RepoKnowledgeConfig,
  expected: RepoKnowledgeConfig,
  operation: string,
): void {
  if (configsEqual(actual, expected)) return;
  throw new GuidedSetupError(
    "SETUP_CONFIG_CONFLICT",
    `config changed concurrently during ${operation}; automatic rollback was refused`,
  );
}

function doctorFailureMessage(report: DoctorReport, prefix: string): string {
  const failures = report.checks
    .filter((check) => check.status === "fail")
    .map(
      (check) =>
        `${check.id}: ${check.message}` +
        (check.remedy === undefined ? "" : ` Remedy: ${check.remedy}`),
    );
  return failures.length === 0 ? prefix : `${prefix}; ${failures.join(" | ")}`;
}

function isExternalAssociation(value: string | undefined): boolean {
  return (
    value === "NONE" ||
    value === "FIRST_TIME_CONTRIBUTOR" ||
    value === "FIRST_TIMER"
  );
}

function addSetValue(
  target: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const values = target.get(key) ?? new Set<string>();
  values.add(value);
  target.set(key, values);
}
