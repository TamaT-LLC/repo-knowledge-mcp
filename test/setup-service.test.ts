import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalTransactionStore,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DistillJobCoordinator,
  ProviderDistillationService,
  computeDistillationInputDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  computeTrustPolicyDigest,
  parseDistillationPrompt,
  GuidedSetupService,
  SetupStateStore,
  collectSetupTrustCandidates,
  initializeStorage,
  loadRepoKnowledgeConfig,
  parseRepoKnowledgeConfig,
  updateRepoKnowledgeConfig,
  type CommentObservation,
  type DoctorReport,
  type GuidedSetupDependencies,
  type RepoKnowledgeConfig,
  type RepositoryResolution,
  type SetupTrustCandidate,
  type SyncCheckpoint,
  type SyncRepoSummary,
} from "../src/experimental.js";

import { renderGuidedSetupSummary } from "../src/cli-render.js";
import { checkTransmissionConfiguration } from "../src/doctor/checks-runtime.js";
import { DoctorReportBuilder } from "../src/doctor/report-builder.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const DEFAULT_SINCE = "2026-05-11T00:00:00.000Z";
const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("guided setup service", () => {
  it("uses safe defaults, a 90-day initial window, and explicit human trust", async () => {
    const current = await fixture({
      candidates: [
        {
          actorId: "U_alice",
          alreadyTrusted: false,
          commentCount: 4,
          login: "alice",
        },
      ],
    });
    const confirmations: string[] = [];
    const progress: string[] = [];

    const result = await current.service.run(
      { repo: REPOSITORY, workspacePath: current.workspacePath },
      {
        async confirm(request) {
          confirmations.push(request.id);
          return request.id === "trust.U_alice";
        },
        progress(update) {
          progress.push(`${update.id}:${update.state}`);
        },
      },
    );

    expect(confirmations).toEqual([
      "transmission.provider",
      "transmission.host-assisted",
      "trust.U_alice",
    ]);
    expect(progress).toEqual([
      "setup.resolve:started",
      "setup.resolve:succeeded",
      "setup.prepare:started",
      "setup.prepare:succeeded",
      "setup.preflight:started",
      "setup.preflight:succeeded",
      "setup.sync:started",
      "setup.sync:succeeded",
      "setup.trust:started",
      "setup.trust:succeeded",
      "setup.redistill:started",
      "setup.redistill:succeeded",
      "setup.doctor:started",
      "setup.doctor:succeeded",
    ]);
    expect(current.sync).toHaveBeenCalledWith(current.repository, {
      since: DEFAULT_SINCE,
    });
    expect(result).toMatchObject({
      initial_sync: {
        scope: { mode: "since", since: DEFAULT_SINCE },
      },
      repository: {
        id: REPOSITORY_ID,
        name: REPOSITORY,
        workspace_path: current.workspacePath,
      },
      resumed: false,
      transmission: { host_assisted: false, provider: false },
      trust: {
        candidates: 1,
        selected: [{ actor_id: "U_alice", login: "alice" }],
      },
    });
    const config = await loadRepoKnowledgeConfig(current.configPath);
    expect(config).toMatchObject({
      defaultRepo: REPOSITORY,
      hostAssistedDistillation: {
        allowReviewContentTransmission: false,
        enabled: false,
      },
      llm: { allowCloudTransmission: false, mode: "disabled" },
      repos: [REPOSITORY],
      trust: {
        autoActivateTrustedHuman: false,
        trustedActorIds: ["U_alice"],
        trustedLogins: ["alice"],
      },
      workspaceMappings: { [current.workspacePath]: REPOSITORY },
    });
    await expect(current.stateStore.read()).resolves.toMatchObject({
      initial_since: DEFAULT_SINCE,
      phase: "complete",
      repo_id: REPOSITORY_ID,
    });
    expect(current.redistill).toHaveBeenCalledOnce();
    await expect(
      access(join(current.workspacePath, ".repo-knowledge")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])(
    "reports effective repository consent when the global default is %s",
    async (globalConsent) => {
      const current = await fixture({
        config: {
          llm: {
            mode: "anthropic",
            model: "fixture-model",
            allowCloudTransmission: globalConsent,
          },
          mergeClassifier: {
            mode: "jev",
            allowCloudTransmission: globalConsent,
          },
          repoPolicies: {
            [REPOSITORY]: {
              allowCloudTransmission: !globalConsent,
              allowCloudMergeClassification: !globalConsent,
            },
          },
        },
      });
      const notices: string[] = [];
      const confirmations: { message: string; defaultValue: boolean }[] = [];
      const completeStructured = vi.fn(async () => ({
        model: "fixture-model",
        outputText: JSON.stringify({
          candidates: [],
          skip_reason: "pr_specific",
        }),
        provider: "anthropic" as const,
      }));
      const reports: DoctorReport[] = [];
      current.runDoctor.mockImplementation(async () => {
        const report = new DoctorReportBuilder();
        await checkTransmissionConfiguration(
          report,
          await loadRepoKnowledgeConfig(current.configPath),
          {
            inspect: async () => ({ authenticated: true, cliAvailable: true }),
          },
          { apiKey: "fixture-only", source: "environment" },
          REPOSITORY,
        );
        const result = report.build();
        reports.push(result);
        return result;
      });
      current.sync.mockImplementation(async () => {
        // Assert disclosure happened before the same config reaches an actual fake adapter.
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain(
          `provider ${globalConsent ? "off" : "on"} · Jev ${globalConsent ? "off" : "on"}`,
        );
        const config = await loadRepoKnowledgeConfig(current.configPath);
        const execution = await runPolicyProvider(
          config,
          current.repository,
          completeStructured,
        );
        expect(execution.state).toBe(globalConsent ? "pending" : "extracted");
        return syncSummary();
      });
      const result = await current.service.run(
        { repo: REPOSITORY },
        {
          confirm: async (request) => {
            confirmations.push(request);
            return false;
          },
          notice: (message) => notices.push(message),
        },
      );
      expect(completeStructured).toHaveBeenCalledTimes(globalConsent ? 0 : 1);
      expect(result.transmission).toMatchObject({
        global_defaults: {
          provider: globalConsent,
          merge_classifier: globalConsent,
        },
        repository_overrides: {
          provider: !globalConsent,
          merge_classifier: !globalConsent,
        },
      });
      for (const report of reports) {
        for (const id of [
          "config.provider_transmission",
          "config.merge_classifier_transmission",
        ]) {
          expect(
            report.checks.find((check) => check.id === id)?.details,
          ).toMatchObject({
            enabled: !globalConsent,
            global_consent: globalConsent,
            repository_override: !globalConsent,
          });
        }
      }
      expect(notices[0]).toContain("Before initial sync for owner/repository");
      expect(notices[0]).toContain("including future repositories");
      expect(notices[0]).toContain("host-assisted is global-only");
      expect(notices[0]).toContain(
        "does not disable normal approved-rule outputs",
      );
      const rendered = renderGuidedSetupSummary(result);
      expect(rendered).toContain(
        `provider ${globalConsent ? "off" : "on"} · Jev ${globalConsent ? "off" : "on"}`,
      );
      expect(rendered).toContain(
        `Global consent defaults: provider ${String(globalConsent)}`,
      );
      expect(rendered).toContain(
        `Repository overrides: provider ${String(!globalConsent)}`,
      );
      if (!globalConsent) {
        expect(confirmations[0]?.message).toContain(
          "Current repository route: on",
        );
        expect(confirmations[0]?.message).toContain(
          "explicit true override, which setup preserves",
        );
      }
      expect(confirmations.every((request) => !request.defaultValue)).toBe(
        true,
      );
      expect(result.transmission.provider).toBe(!globalConsent);
      expect(result.transmission.merge_classifier).toBe(!globalConsent);
      const persisted = await loadRepoKnowledgeConfig(current.configPath);
      expect(persisted.llm.allowCloudTransmission).toBe(globalConsent);
      expect(persisted.mergeClassifier.allowCloudTransmission).toBe(
        globalConsent,
      );
      expect(persisted.repoPolicies[REPOSITORY]).toEqual({
        allowCloudTransmission: !globalConsent,
        allowCloudMergeClassification: !globalConsent,
      });
    },
  );

  it("discloses global consent inherited by a future repository without changing overrides", async () => {
    const first = await fixture({ typesafeApiKeyAvailable: true });
    const prompts: { id: string; message: string; defaultValue: boolean }[] =
      [];
    await first.service.run(
      { repo: REPOSITORY },
      {
        confirm: async (request) => {
          prompts.push(request);
          return true;
        },
        input: async (request) =>
          request.id === "transmission.provider-mode"
            ? "anthropic"
            : "fixture-model",
      },
    );
    for (const prompt of prompts) {
      expect(prompt.defaultValue).toBe(false);
      expect(prompt.message).toContain(
        "all repositories sharing this storage, including future repositories",
      );
    }
    expect(
      prompts.find((prompt) => prompt.id === "transmission.provider")?.message,
    ).toContain("allowCloudTransmission");
    expect(
      prompts.find((prompt) => prompt.id === "transmission.merge-classifier")
        ?.message,
    ).toContain("allowCloudMergeClassification");
    expect(
      prompts.find((prompt) => prompt.id === "transmission.host-assisted")
        ?.message,
    ).toContain("no repository override");

    const inherited = await loadRepoKnowledgeConfig(first.configPath);
    const second = await fixture({
      storageRoot: first.storageRoot,
      repositoryName: "owner/future",
      repositoryId: "R_future",
    });
    const confirm = vi.fn(async () => false);
    const notices: string[] = [];
    second.sync.mockImplementation(async () => {
      expect(notices[0]).toContain("Before initial sync for owner/future");
      expect(notices[0]).toContain("provider on · Jev on · host-assisted on");
      expect(notices[0]).toContain(
        "Repository overrides: provider inherit · Jev inherit",
      );
      return syncSummary();
    });
    const result = await second.service.run(
      { repo: "owner/future" },
      { confirm, notice: (message) => notices.push(message) },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result.transmission).toMatchObject({
      provider: true,
      merge_classifier: true,
      host_assisted: true,
    });
    const after = await loadRepoKnowledgeConfig(second.configPath);
    expect(after.llm).toEqual(inherited.llm);
    expect(after.mergeClassifier).toEqual(inherited.mergeClassifier);
    expect(after.hostAssistedDistillation).toEqual(
      inherited.hostAssistedDistillation,
    );
  });

  it("preserves an explicit repository denial when enabling global defaults", async () => {
    const current = await fixture({
      config: {
        repoPolicies: {
          [REPOSITORY]: {
            allowCloudTransmission: false,
            allowCloudMergeClassification: false,
          },
        },
      },
      typesafeApiKeyAvailable: true,
    });
    const prompts: string[] = [];
    const result = await current.service.run(
      { repo: REPOSITORY },
      {
        confirm: async (request) => {
          prompts.push(request.message);
          return request.id !== "transmission.host-assisted";
        },
        input: async (request) =>
          request.id === "transmission.provider-mode"
            ? "anthropic"
            : "fixture-model",
      },
    );
    expect(prompts[0]).toContain("Current repository route: off");
    expect(prompts[0]).toContain(
      "explicit false override, which setup preserves",
    );
    expect(prompts[1]).toContain("Current repository Jev route: off");
    expect(result.transmission).toMatchObject({
      provider: false,
      merge_classifier: false,
      global_defaults: { provider: true, merge_classifier: true },
      repository_overrides: { provider: false, merge_classifier: false },
    });
  });

  it("resumes a partial initial sync from its checkpoint without duplicate config", async () => {
    const current = await fixture();
    current.readSyncCheckpoint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(checkpoint("2026-08-01T00:00:00.000Z"));
    current.sync
      .mockResolvedValueOnce(syncSummary({ failed: 1 }))
      .mockResolvedValueOnce(syncSummary());
    const confirm = vi.fn(async () => false);

    await expect(
      current.service.run({ repo: REPOSITORY }, { confirm }),
    ).rejects.toMatchObject({ code: "SETUP_SYNC_FAILED" });
    const result = await current.service.run({ repo: REPOSITORY }, { confirm });

    expect(current.sync.mock.calls).toEqual([
      [current.repository, { since: DEFAULT_SINCE }],
      [current.repository, {}],
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(result.resumed).toBe(true);
    expect(result.initial_sync.scope).toEqual({
      mode: "since",
      since: DEFAULT_SINCE,
    });
    const config = await loadRepoKnowledgeConfig(current.configPath);
    expect(config.repos).toEqual([REPOSITORY]);
    expect(await current.stateStore.read()).toMatchObject({
      phase: "complete",
    });
  });

  it("widens a preexisting checkpoint for all-history, then resumes incrementally", async () => {
    const current = await fixture();
    current.readSyncCheckpoint.mockResolvedValue(
      checkpoint("2026-08-01T00:00:00.000Z"),
    );
    current.sync
      .mockResolvedValueOnce(syncSummary({ failed: 1 }))
      .mockResolvedValueOnce(syncSummary());

    await expect(
      current.service.run(
        { allHistory: true, repo: REPOSITORY },
        { confirm: async () => false },
      ),
    ).rejects.toMatchObject({ code: "SETUP_SYNC_FAILED" });
    await expect(
      current.service.run(
        { allHistory: true, repo: REPOSITORY },
        { confirm: async () => false },
      ),
    ).resolves.toMatchObject({
      initial_sync: { scope: { mode: "all-history", since: null } },
      resumed: true,
    });

    expect(current.sync.mock.calls).toEqual([
      [current.repository, { since: "1970-01-01T00:00:00.000Z" }],
      [current.repository, {}],
    ]);
  });

  it("resumes an older pre-setup checkpoint instead of passing a newer since", async () => {
    const current = await fixture();
    current.readSyncCheckpoint.mockResolvedValue(
      checkpoint("2026-05-10T00:00:00.000Z"),
    );

    await current.service.run(
      { repo: REPOSITORY },
      { confirm: async () => false },
    );

    expect(current.sync).toHaveBeenCalledWith(current.repository, {});
  });

  it("widens a newer pre-setup checkpoint to the requested initial boundary", async () => {
    const current = await fixture();
    current.readSyncCheckpoint.mockResolvedValue(
      checkpoint("2026-06-01T00:00:00.000Z"),
    );

    await current.service.run(
      { repo: REPOSITORY },
      { confirm: async () => false },
    );

    expect(current.sync).toHaveBeenCalledWith(current.repository, {
      since: DEFAULT_SINCE,
    });
  });

  it.each([
    {
      inputMode: "anthropic",
      message:
        "Anthropic (Claude Code) subscription model ID (login: claude auth login)",
      mode: "anthropic",
      model: "claude-setup-test",
    },
    {
      inputMode: "openai",
      message: "OpenAI (Codex) subscription model ID (login: codex login)",
      mode: "openai",
      model: "openai-setup-test",
    },
    {
      inputMode: "grok",
      message: "xAI (Grok CLI) subscription model ID (login: grok login)",
      mode: "xai",
      model: "grok-setup-test",
    },
  ] as const)(
    "collects provider mode $mode and model atomically when transmission is enabled",
    async ({ inputMode, message, mode, model }) => {
      const current = await fixture();
      const input = vi
        .fn()
        .mockResolvedValueOnce(` ${inputMode} `)
        .mockResolvedValueOnce(` ${model} `);

      const result = await current.service.run(
        { repo: REPOSITORY },
        {
          confirm: async (request) => request.id === "transmission.provider",
          input,
        },
      );

      expect(input.mock.calls).toEqual([
        [
          {
            id: "transmission.provider-mode",
            message: "LLM provider (anthropic, openai, xai)",
          },
        ],
        [{ id: "transmission.provider-model", message }],
      ]);
      expect(await loadRepoKnowledgeConfig(current.configPath)).toMatchObject({
        llm: {
          allowCloudTransmission: true,
          mode,
          model,
        },
      });
      expect(result.transmission.provider).toBe(true);
    },
  );

  it("offers Jev during provider setup when TYPESAFE_API_KEY is available", async () => {
    const current = await fixture({ typesafeApiKeyAvailable: true });
    const confirmations: string[] = [];
    const input = vi
      .fn()
      .mockResolvedValueOnce("anthropic")
      .mockResolvedValueOnce("claude-test");

    const result = await current.service.run(
      { repo: REPOSITORY },
      {
        async confirm(request) {
          confirmations.push(request.id);
          return (
            request.id === "transmission.provider" ||
            request.id === "transmission.merge-classifier"
          );
        },
        input,
      },
    );

    expect(confirmations).toEqual([
      "transmission.provider",
      "transmission.merge-classifier",
      "transmission.host-assisted",
    ]);
    expect(result.transmission.merge_classifier).toBe(true);
    expect(await loadRepoKnowledgeConfig(current.configPath)).toMatchObject({
      mergeClassifier: {
        allowCloudTransmission: true,
        minimumSameConfidence: 0.9,
        mode: "jev",
        model: "jev-latest",
      },
    });
  });

  it("rolls config back when doctor fails before the initial sync", async () => {
    const current = await fixture();
    const before = await loadRepoKnowledgeConfig(current.configPath);
    current.runDoctor.mockResolvedValueOnce(failedDoctor());

    await expect(
      current.service.run(
        { repo: REPOSITORY, workspacePath: current.workspacePath },
        {
          confirm: async () => true,
          input: async (request) =>
            request.id === "transmission.provider-mode"
              ? "anthropic"
              : "claude-test",
        },
      ),
    ).rejects.toMatchObject({ code: "SETUP_DOCTOR_FAILED" });

    expect(await loadRepoKnowledgeConfig(current.configPath)).toEqual(before);
    expect(await current.stateStore.read()).toBeNull();
    expect(current.sync).not.toHaveBeenCalled();
  });

  it("rolls config back when repository preparation fails", async () => {
    const current = await fixture();
    const before = await loadRepoKnowledgeConfig(current.configPath);
    const progress: string[] = [];
    current.prepareRepository.mockRejectedValueOnce(
      new Error("projection unavailable"),
    );

    await expect(
      current.service.run(
        { repo: REPOSITORY, workspacePath: current.workspacePath },
        {
          confirm: async () => false,
          progress: (update) => progress.push(`${update.id}:${update.state}`),
        },
      ),
    ).rejects.toMatchObject({ code: "SETUP_PREPARATION_FAILED" });

    expect(await loadRepoKnowledgeConfig(current.configPath)).toEqual(before);
    expect(await current.stateStore.read()).toBeNull();
    expect(current.runDoctor).not.toHaveBeenCalled();
    expect(current.sync).not.toHaveBeenCalled();
    expect(progress).toContain("setup.prepare:started");
    expect(progress).toContain("setup.prepare:failed");
    expect(progress).not.toContain("setup.prepare:succeeded");
  });

  it("rolls newly selected trust back when final doctor fails", async () => {
    const current = await fixture({
      candidates: [
        {
          actorId: "U_alice",
          alreadyTrusted: false,
          commentCount: 1,
          login: "alice",
        },
      ],
    });
    current.runDoctor
      .mockResolvedValueOnce(healthyDoctor())
      .mockResolvedValueOnce(failedDoctor());

    await expect(
      current.service.run(
        { repo: REPOSITORY },
        {
          confirm: async (request) => request.id === "trust.U_alice",
        },
      ),
    ).rejects.toMatchObject({ code: "SETUP_DOCTOR_FAILED" });

    const config = await loadRepoKnowledgeConfig(current.configPath);
    expect(config.trust.trustedActorIds).toEqual([]);
    expect(config.trust.trustedLogins).toEqual([]);
    expect(await current.stateStore.read()).toMatchObject({ phase: "synced" });
    expect(current.redistill).toHaveBeenCalledOnce();
  });

  it("repairs a trust-config checkpoint interrupted after config persistence", async () => {
    const current = await fixture({
      candidates: [
        {
          actorId: "U_alice",
          alreadyTrusted: false,
          commentCount: 1,
          login: "alice",
        },
      ],
    });
    const originalWrite = current.stateStore.write.bind(current.stateStore);
    let interruptTrustCheckpoint = true;
    vi.spyOn(current.stateStore, "write").mockImplementation(async (state) => {
      if (state.phase === "trust-configured" && interruptTrustCheckpoint) {
        interruptTrustCheckpoint = false;
        throw new Error("interrupted checkpoint write");
      }
      return originalWrite(state);
    });

    await expect(
      current.service.run(
        { repo: REPOSITORY },
        {
          confirm: async (request) => request.id === "trust.U_alice",
        },
      ),
    ).rejects.toThrow("interrupted checkpoint write");
    expect(await current.stateStore.read()).toMatchObject({ phase: "synced" });
    expect(
      (await loadRepoKnowledgeConfig(current.configPath)).trust.trustedLogins,
    ).toEqual(["alice"]);

    await expect(
      current.service.run({ repo: REPOSITORY }, { confirm: async () => false }),
    ).resolves.toMatchObject({ resumed: true });
    expect(current.redistill).toHaveBeenCalledOnce();
    expect(await current.stateStore.read()).toMatchObject({
      phase: "complete",
    });
  });

  it("does not overwrite a workspace mapping for another repository", async () => {
    const current = await fixture({ mappedRepository: "other/repository" });
    const before = await loadRepoKnowledgeConfig(current.configPath);

    await expect(
      current.service.run(
        { repo: REPOSITORY, workspacePath: current.workspacePath },
        { confirm: async () => false },
      ),
    ).rejects.toMatchObject({ code: "SETUP_REPOSITORY_MISMATCH" });

    expect(await loadRepoKnowledgeConfig(current.configPath)).toEqual(before);
    expect(current.prepareRepository).not.toHaveBeenCalled();
    expect(current.sync).not.toHaveBeenCalled();
  });

  it("rejects a changed initial scope while resuming", async () => {
    const current = await fixture();
    current.sync.mockResolvedValueOnce(syncSummary({ failed: 1 }));
    await expect(
      current.service.run({ repo: REPOSITORY }, { confirm: async () => false }),
    ).rejects.toMatchObject({ code: "SETUP_SYNC_FAILED" });

    await expect(
      current.service.run(
        { allHistory: true, repo: REPOSITORY },
        { confirm: async () => false },
      ),
    ).rejects.toMatchObject({ code: "SETUP_RESUME_SCOPE_MISMATCH" });
    expect(current.sync).toHaveBeenCalledTimes(1);
  });
});

describe("setup trust candidates", () => {
  it("keeps only unambiguous non-external human identities", () => {
    const comments = [
      comment("1", human("U_alice", "alice", "MEMBER")),
      comment("2", human("U_alice", "alice", "OWNER")),
      comment("3", {
        actor_id: "B_bot",
        actor_kind: "bot",
        login: "review-bot[bot]",
        provider: "greptile",
        trust: "untrusted",
      }),
      comment("4", human("U_external", "external", "NONE")),
      comment("5", human("U_ambiguous_a", "ambiguous", "MEMBER")),
      comment("6", human("U_ambiguous_b", "ambiguous", "MEMBER")),
      comment("7", human("U_alias", "first-alias", "MEMBER")),
      comment("8", human("U_alias", "second-alias", "MEMBER")),
      comment("9", {
        actor_kind: "user",
        author_association: "MEMBER",
        login: "missing-id",
        provider: "human",
        trust: "unknown",
      }),
      comment("10", {
        actor_id: "U_missing_login",
        actor_kind: "user",
        author_association: "MEMBER",
        login: null,
        provider: "human",
        trust: "unknown",
      }),
      comment("11", {
        actor_id: "U_missing_association",
        actor_kind: "user",
        login: "legacy-user",
        provider: "human",
        trust: "unknown",
      }),
      comment("12", {
        actor_id: "U_bot_like",
        actor_kind: "user",
        author_association: "MEMBER",
        login: "unknown-reviewer[bot]",
        provider: "human",
        trust: "unknown",
      }),
    ];
    const config = parseRepoKnowledgeConfig({
      trust: { trustedLogins: ["alice", "first-alias"] },
    });

    expect(collectSetupTrustCandidates(comments, config)).toEqual([
      {
        actorId: "U_alice",
        alreadyTrusted: true,
        commentCount: 2,
        login: "alice",
      },
      {
        actorId: "U_alias",
        alreadyTrusted: true,
        commentCount: 2,
        login: "second-alias",
      },
    ]);
  });
});

interface FixtureOverrides {
  readonly candidates?: readonly SetupTrustCandidate[];
  readonly config?: Record<string, unknown>;
  readonly storageRoot?: string;
  readonly repositoryName?: string;
  readonly repositoryId?: string;
  readonly mappedRepository?: string;
  readonly typesafeApiKeyAvailable?: boolean;
}

/** Creates isolated setup dependencies, optionally sharing storage with a second repository. */
async function fixture(overrides: FixtureOverrides = {}) {
  const parent = await temporaryDirectory();
  const storageRoot = overrides.storageRoot ?? join(parent, "storage");
  const repositoryName = overrides.repositoryName ?? REPOSITORY;
  const repositoryId = overrides.repositoryId ?? REPOSITORY_ID;
  const workspacePath = join(parent, "workspace");
  await mkdir(workspacePath, { mode: 0o700 });
  const initialized = await initializeStorage(
    storageRoot,
    overrides.mappedRepository === undefined
      ? (overrides.config ?? {})
      : {
          ...overrides.config,
          workspaceMappings: {
            [workspacePath]: overrides.mappedRepository,
          },
        },
  );
  const repositoryRoot = join(storageRoot, "repos", repositoryId);
  await mkdir(repositoryRoot, { mode: 0o700, recursive: true });
  const repository: RepositoryResolution = {
    absolutePath: repositoryRoot,
    aliases: [],
    currentName: repositoryName,
    path: `repos/${repositoryId}`,
    repoId: repositoryId,
    source: "tool-repo",
    workspacePath,
  };
  const stateStore = new SetupStateStore(repositoryRoot);
  const readSyncCheckpoint = vi.fn<
    GuidedSetupDependencies["readSyncCheckpoint"]
  >(async () => null);
  const sync = vi.fn(async () => syncSummary());
  const runDoctor = vi.fn(async () => healthyDoctor());
  const prepareRepository = vi.fn(async () => undefined);
  const redistill = vi.fn(async () => ({
    created_jobs: 0,
    reclassified_comments: 0,
    reset_jobs: 0,
    selected_threads: 0,
    unchanged: 0,
  }));
  const dependencies: GuidedSetupDependencies = {
    clock: () => NOW,
    initializeStorage: () => initializeStorage(storageRoot),
    prepareRepository,
    readTrustCandidates: async (_repository, config) =>
      (overrides.candidates ?? []).map((candidate) => ({
        ...candidate,
        alreadyTrusted:
          candidate.alreadyTrusted ||
          config.trust.trustedActorIds.includes(candidate.actorId) ||
          config.trust.trustedLogins.includes(candidate.login),
      })),
    readSyncCheckpoint,
    redistill,
    resolveRepository: async () => repository,
    runDoctor,
    stateStore: () => stateStore,
    sync,
    typesafeApiKeyAvailable: () => overrides.typesafeApiKeyAvailable ?? false,
    updateConfig: (configPath, update) =>
      updateRepoKnowledgeConfig(configPath, update),
  };
  return {
    configPath: initialized.configPath,
    prepareRepository,
    readSyncCheckpoint,
    redistill,
    repository,
    runDoctor,
    service: new GuidedSetupService(dependencies),
    stateStore,
    storageRoot,
    sync,
    workspacePath,
  };
}

/** Runs a synthetic pending job through the real policy gate and an injected fake adapter. */
async function runPolicyProvider(
  config: RepoKnowledgeConfig,
  repository: RepositoryResolution,
  completeStructured: () => Promise<{
    model: string;
    outputText: string;
    provider: "anthropic";
  }>,
) {
  const prompt = parseDistillationPrompt(
    "---\nprompt_version: policy-test\n---\nReturn synthetic fixture output.\n",
  );
  const normalizedActors = [
    {
      authorAssociation: "MEMBER",
      actor_id: "U_fixture",
      actor_kind: "user" as const,
      login: "fixture",
      provider: "human" as const,
      trust: "trusted" as const,
    },
  ];
  const normalizedComments = [
    {
      id: "fixture-comment",
      body: "Synthetic review body",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  ];
  const threadId = "fixture-thread";
  const path = "src/fixture.ts";
  const repositoryContext = {};
  const distillationInputDigest = computeDistillationInputDigest({
    normalizedActors,
    normalizedComments,
    path,
    repositoryContext,
    threadId,
  });
  const distillationKey = computeThreadDistillationKey({
    distillationInputDigest,
    outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    promptDigest: prompt.promptDigest,
    trustPolicyDigest: computeTrustPolicyDigest(config.trust),
  });
  const thread = {
    normalizedActors,
    normalizedComments,
    path,
    threadId,
    distillationInputDigest,
    distillationKey,
    contentFingerprint: computeThreadContentFingerprint(
      threadId,
      path,
      normalizedComments,
    ),
  };
  const coordinator = new DistillJobCoordinator(
    new CanonicalTransactionStore(repository.absolutePath),
  );
  const created = await coordinator.createJob({
    distillation_key: distillationKey,
    repo_id: repository.repoId,
    thread_id: threadId,
  });
  return new ProviderDistillationService({
    diagnosticSink: () => undefined,
    adapter: { provider: "anthropic", completeStructured },
    config,
    prompt,
    repository,
  }).run({ job_id: created.job.job_id, repositoryContext, thread });
}

function healthyDoctor(): DoctorReport {
  return {
    checks: [],
    ok: true,
    summary: { fail: 0, pass: 12, warn: 0 },
  };
}

function failedDoctor(): DoctorReport {
  return {
    checks: [
      {
        id: "github.auth",
        message: "not authenticated",
        status: "fail",
      },
    ],
    ok: false,
    summary: { fail: 1, pass: 11, warn: 0 },
  };
}

function syncSummary(
  overrides: Partial<SyncRepoSummary> = {},
): SyncRepoSummary {
  return {
    discovered: 1,
    failed: 0,
    failures: [],
    ingested: 1,
    jobs_created: 1,
    next_cursor: null,
    unchanged: 0,
    ...overrides,
  };
}

function checkpoint(lastUpdatedAt: string): SyncCheckpoint {
  return {
    cursor: {
      last_pr_number: 7,
      last_updated_at: lastUpdatedAt,
      repo_id: REPOSITORY_ID,
      version: 1,
    },
    schema_version: 1,
    updated_at: lastUpdatedAt,
  };
}

function human(
  actorId: string,
  login: string,
  authorAssociation: string,
): CommentObservation["actor"] {
  return {
    actor_id: actorId,
    actor_kind: "user",
    author_association: authorAssociation,
    login,
    provider: "human",
    trust: "unknown",
  };
}

function comment(
  suffix: string,
  actor: CommentObservation["actor"],
): CommentObservation {
  return {
    actor,
    body: "review comment",
    comment_id: `C_${suffix}`,
    created_at: "2026-08-01T00:00:00.000Z",
    observation_id: `obs_01ARZ3NDEKTSV4RRFFQ69G5FA${suffix.padStart(1, "0")}`,
    observation_type: "comment",
    observed_at: "2026-08-01T00:00:00.000Z",
    snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    thread_id: `thread-${suffix}`,
    updated_at: "2026-08-01T00:00:00.000Z",
    url: `https://github.com/${REPOSITORY}/pull/1#discussion_r${suffix}`,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-guided-setup-"));
  temporaryDirectories.push(path);
  return path;
}
