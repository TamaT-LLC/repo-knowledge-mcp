import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  MAX_OUTCOME_FILE_PATHS,
  MAX_OUTCOME_NOTE_LENGTH,
  MAX_OUTCOME_TASK_ID_LENGTH,
  OUTCOME_EVENT_PATH,
  OUTCOME_RECORDED_RECORD_TYPE,
  RecordOutcomeMutationService,
  serializeKnowledgeDocument,
  type CanonicalCommitPoint,
  type CanonicalProjectionSnapshot,
  type KnowledgeStatus,
} from "../src/index.js";

const NOW = "2026-08-07T01:00:00.000Z";
const CREATED_AT = "2026-08-06T00:00:00.000Z";
const REPO = "owner/repository";
const REPO_ID = "repo-outcome";
const OTHER_REPO_ID = "repo-other";
const ACTIVE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROPOSED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const FOREIGN_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const UNKNOWN_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("RecordOutcomeMutationService canonical append", () => {
  it("records an outcome as one OutcomeRecorded event and projects the counts", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);

    const result = await service(store).recordOutcome(baseRequest());

    expect(result).toEqual({
      applied_count: 1,
      event_id: EVENT_ID,
      knowledge_id: ACTIVE_ID,
      outcome: "applied",
      replayed: false,
      violation_count: 0,
    });
    const lines = await readOutcomeLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      payload: {
        at: NOW,
        context: {
          file_paths: ["src/feature/a.ts"],
          pr_number: 7,
          task_id: "task-1",
        },
        knowledge_id: ACTIVE_ID,
        note: "applied cleanly",
        outcome: "applied",
        repo_id: REPO_ID,
      },
      record_id: EVENT_ID,
      record_type: OUTCOME_RECORDED_RECORD_TYPE,
      schema_version: 1,
    });
    expect(countsOf(await store.readSnapshot(), ACTIVE_ID)).toEqual({
      applied: 1,
      violated: 0,
    });
  });

  it("normalizes file_paths into sorted repository-relative POSIX paths", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);

    await service(store).recordOutcome(
      baseRequest({
        context: {
          file_paths: [
            "src\\nested\\b.ts",
            "./src/feature/a.ts",
            "src/feature/a.ts",
          ],
        },
      }),
    );

    const lines = await readOutcomeLines(root);
    expect(lines[0]).toMatchObject({
      payload: {
        context: { file_paths: ["src/feature/a.ts", "src/nested/b.ts"] },
      },
    });
  });
});

describe("RecordOutcomeMutationService idempotency", () => {
  it("replays the same event_id and payload without a second count", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);
    const outcomes = service(store);

    const first = await outcomes.recordOutcome(baseRequest());
    const replay = await outcomes.recordOutcome(baseRequest());

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await readOutcomeLines(root)).toHaveLength(1);
    expect(countsOf(await store.readSnapshot(), ACTIVE_ID)).toEqual({
      applied: 1,
      violated: 0,
    });
  });

  it("treats pre-normalization file_path variants as the same payload", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);
    const outcomes = service(store);
    await outcomes.recordOutcome(
      baseRequest({ context: { file_paths: ["src/feature/a.ts"] } }),
    );

    const replay = await outcomes.recordOutcome(
      baseRequest({
        context: { file_paths: ["./src/feature/a.ts"] },
      }),
    );

    expect(replay.replayed).toBe(true);
    expect(await readOutcomeLines(root)).toHaveLength(1);
  });

  it("rejects the same event_id with a different payload as a conflict", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);
    const outcomes = service(store);
    await outcomes.recordOutcome(baseRequest());

    await expect(
      outcomes.recordOutcome(baseRequest({ outcome: "violated" })),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      name: "RecordOutcomeError",
    });

    expect(await readOutcomeLines(root)).toHaveLength(1);
    expect(countsOf(await store.readSnapshot(), ACTIVE_ID)).toEqual({
      applied: 1,
      violated: 0,
    });
  });
});

describe("RecordOutcomeMutationService knowledge binding", () => {
  it.each([
    { code: "KNOWLEDGE_NOT_FOUND", knowledgeId: UNKNOWN_ID },
    { code: "KNOWLEDGE_REPOSITORY_MISMATCH", knowledgeId: FOREIGN_ID },
    { code: "KNOWLEDGE_NOT_ACTIVE", knowledgeId: PROPOSED_ID },
  ])(
    "rejects $code without any canonical write",
    async ({ code, knowledgeId }) => {
      const root = await createFixture();
      const store = new CanonicalTransactionStore(root);

      await expect(
        service(store).recordOutcome(
          baseRequest({ knowledge_id: knowledgeId }),
        ),
      ).rejects.toMatchObject({ code, name: "RecordOutcomeError" });

      await expect(readOutcomeLines(root)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("RecordOutcomeMutationService request contract", () => {
  it.each([
    { name: "a malformed event_id", request: { event_id: "evt-123" } },
    {
      name: "a malformed knowledge_id",
      request: { knowledge_id: "kn-123" },
    },
    { name: "a missing timestamp", request: { at: undefined } },
    { name: "an unknown outcome", request: { outcome: "ignored" } },
    {
      name: "a note over the limit",
      request: { note: "a".repeat(MAX_OUTCOME_NOTE_LENGTH + 1) },
    },
    { name: "an empty context", request: { context: {} } },
    {
      name: "an empty file_paths array",
      request: { context: { file_paths: [] } },
    },
    {
      name: "too many file_paths",
      request: {
        context: {
          file_paths: Array.from(
            { length: MAX_OUTCOME_FILE_PATHS + 1 },
            (_, index) => `src/file-${String(index)}.ts`,
          ),
        },
      },
    },
    {
      name: "an absolute file path",
      request: { context: { file_paths: ["/etc/passwd"] } },
    },
    {
      name: "a parent-escaping file path",
      request: { context: { file_paths: ["../escape.ts"] } },
    },
    {
      name: "a task_id over the limit",
      request: {
        context: { task_id: "t".repeat(MAX_OUTCOME_TASK_ID_LENGTH + 1) },
      },
    },
    { name: "an unknown field", request: { unexpected: true } },
  ])("rejects $name without any canonical write", async ({ request }) => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);

    await expect(
      service(store).recordOutcome({ ...baseRequest(), ...request }),
    ).rejects.toMatchObject({
      code: "RECORD_OUTCOME_REQUEST_INVALID",
      name: "RecordOutcomeError",
    });

    await expect(readOutcomeLines(root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("RecordOutcomeMutationService rebuild consistency", () => {
  it("reproduces identical outcome aggregates after deleting index.sqlite", async () => {
    const root = await createFixture();
    const store = new CanonicalTransactionStore(root);
    const outcomes = service(store);
    await outcomes.recordOutcome(baseRequest());
    await outcomes.recordOutcome(
      baseRequest({ event_id: OTHER_EVENT_ID, outcome: "violated" }),
    );
    const before = countsOf(await store.readSnapshot(), ACTIVE_ID);

    await unlink(join(root, "index.sqlite"));
    const rebuilt = await new CanonicalTransactionStore(root).reindex();

    expect(before).toEqual({ applied: 1, violated: 1 });
    expect(countsOf(rebuilt, ACTIVE_ID)).toEqual(before);
  });
});

describe("RecordOutcomeMutationService crash recovery", () => {
  it.each([
    { expectedEvents: 0, point: "after_staged_payloads" },
    { expectedEvents: 0, point: "after_manifest_temp" },
    { expectedEvents: 1, point: "after_prepared" },
    { expectedEvents: 1, point: "before_append_write" },
    { expectedEvents: 1, point: "after_append_write" },
    { expectedEvents: 1, point: "after_committed" },
  ] as const)(
    "applies the event $expectedEvents time(s) after a kill at $point",
    async ({ expectedEvents, point }) => {
      const root = await createFixture();
      let crashed = false;
      const killedStore = new CanonicalTransactionStore(root, {
        faultInjector(currentPoint: CanonicalCommitPoint) {
          if (!crashed && currentPoint === point) {
            crashed = true;
            throw new Error("simulated crash");
          }
        },
      });

      await expect(
        service(killedStore).recordOutcome(baseRequest()),
      ).rejects.toThrow("simulated crash");

      const restarted = new CanonicalTransactionStore(root);
      const recovered = await restarted.readSnapshot();
      expect(
        recovered.domain.outcomes.filter(
          (outcome) => outcome.recordId === EVENT_ID,
        ),
      ).toHaveLength(expectedEvents);
      expect(countsOf(recovered, ACTIVE_ID)).toEqual({
        applied: expectedEvents,
        violated: 0,
      });

      const retried = await service(restarted).recordOutcome(baseRequest());
      expect(retried.replayed).toBe(expectedEvents === 1);
      expect(retried.applied_count).toBe(1);
      expect(await readOutcomeLines(root)).toHaveLength(1);
      expect(countsOf(await restarted.readSnapshot(), ACTIVE_ID)).toEqual({
        applied: 1,
        violated: 0,
      });
    },
  );
});

interface OutcomeRequestOverrides {
  readonly context?: Record<string, unknown>;
  readonly event_id?: string;
  readonly knowledge_id?: string;
  readonly outcome?: string;
}

function baseRequest(
  overrides: OutcomeRequestOverrides = {},
): Record<string, unknown> {
  return {
    at: NOW,
    context: overrides.context ?? {
      file_paths: ["src/feature/a.ts"],
      pr_number: 7,
      task_id: "task-1",
    },
    event_id: overrides.event_id ?? EVENT_ID,
    knowledge_id: overrides.knowledge_id ?? ACTIVE_ID,
    note: "applied cleanly",
    outcome: overrides.outcome ?? "applied",
  };
}

function service(
  store: CanonicalTransactionStore,
): RecordOutcomeMutationService {
  return new RecordOutcomeMutationService({
    now: () => new Date(NOW),
    repo: REPO,
    repoId: REPO_ID,
    repository: store,
  });
}

function countsOf(
  snapshot: CanonicalProjectionSnapshot,
  knowledgeId: string,
): { applied: number; violated: number } {
  const knowledge = snapshot.domain.knowledge.find(
    (candidate) => candidate.id === knowledgeId,
  );
  if (knowledge === undefined) {
    throw new Error(`knowledge ${knowledgeId} is missing from the projection`);
  }
  return {
    applied: knowledge.appliedCount,
    violated: knowledge.violationCount,
  };
}

async function readOutcomeLines(
  root: string,
): Promise<readonly Record<string, unknown>[]> {
  const content = await readFile(join(root, OUTCOME_EVENT_PATH), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rkm-outcome-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "knowledge"), { recursive: true });
  await writeKnowledge(root, ACTIVE_ID, "active", REPO_ID);
  await writeKnowledge(root, PROPOSED_ID, "proposed", REPO_ID);
  await writeKnowledge(root, FOREIGN_ID, "active", OTHER_REPO_ID);
  return root;
}

async function writeKnowledge(
  root: string,
  id: string,
  status: KnowledgeStatus,
  repoId: string,
): Promise<void> {
  const path = `knowledge/${id}.md`;
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: "style",
        created_at: CREATED_AT,
        id,
        origin: { type: "distilled" },
        related_ids: [],
        repo_id: repoId,
        revision: 1,
        rule: `Rule for ${id}`,
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status,
        updated_at: CREATED_AT,
      },
      "Outcome mutation test detail",
    ),
  );
}
