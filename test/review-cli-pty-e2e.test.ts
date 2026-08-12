import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  createDomainId,
  parseKnowledgeDocument,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
} from "../src/index.js";

const REPO = "owner/repository";
const REPO_ID = "R_review_pty";
const CANDIDATE_A = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CANDIDATE_B = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ACTIVE_A = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ACTIVE_B = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const PROPOSAL_A = "proposal-pty-reject";
const PROPOSAL_B = "proposal-pty-edit-approve";
const T0 = "2026-08-09T00:00:00.000Z";
const T1 = "2026-08-09T00:01:00.000Z";
const T2 = "2026-08-09T00:02:00.000Z";
const T3 = "2026-08-09T00:03:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repo-knowledge review PTY E2E", () => {
  it("processes both item kinds, skips, edits, and resumes in real TTY sessions", async () => {
    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Approve candidate A" },
        { createdAt: T1, id: CANDIDATE_B, rule: "Skip candidate B" },
      ],
      proposals: [
        {
          createdAt: T2,
          id: PROPOSAL_A,
          knowledgeId: ACTIVE_A,
          patch: { rule: "Rejected revision A" },
        },
        {
          createdAt: T3,
          id: PROPOSAL_B,
          knowledgeId: ACTIVE_B,
          patch: { rule: "Approved revision B", severity: "must" },
        },
      ],
    });
    const first = await startPty(fixture);

    await first.waitFor("Approve candidate A");
    await first.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    first.send("approve\n");
    await first.waitFor("Skip candidate B");
    await first.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    first.send("skip\n");
    await first.waitFor(PROPOSAL_A);
    await first.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    first.send("reject\n");
    await first.waitFor(PROPOSAL_B);
    await first.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    first.send("edit\n");
    await first.waitFor("Field [rule/detail/category/severity/scope]");
    first.send("severity\n");
    await first.waitFor("New severity");
    first.send("should\n");
    await first.waitFor("Edited successfully");
    await first.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    first.send("approve\n");
    const firstResult = await first.finish();

    expect(firstResult.exitCode, firstResult.output).toBe(0);
    expect(firstResult.output).toContain("1 skipped");
    let snapshot = await fixture.store.readSnapshot();
    expect(status(snapshot, CANDIDATE_A)).toBe("active");
    expect(status(snapshot, CANDIDATE_B)).toBe("proposed");
    expect(proposal(snapshot, PROPOSAL_A).status).toBe("rejected");
    expect(proposal(snapshot, PROPOSAL_B)).toMatchObject({
      patch: { rule: "Approved revision B", severity: "should" },
      status: "approved",
    });
    expect(rule(snapshot, ACTIVE_B)).toBe("Approved revision B");

    const resumed = await startPty(fixture);
    await resumed.waitFor("Skip candidate B");
    await resumed.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    resumed.send("edit\n");
    await resumed.waitFor("Field [rule/detail/category/severity/scope]");
    resumed.send("rule\n");
    await resumed.waitFor("New rule");
    resumed.send("Edited candidate B\n");
    await resumed.waitFor("Edited candidate B");
    await resumed.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    resumed.send("approve\n");
    const resumedResult = await resumed.finish();

    expect(resumedResult.exitCode, resumedResult.output).toBe(0);
    snapshot = await fixture.store.readSnapshot();
    expect(status(snapshot, CANDIDATE_B)).toBe("active");
    expect(rule(snapshot, CANDIDATE_B)).toBe("Edited candidate B");
  }, 30_000);

  it("reloads a concurrent exact-byte change before approval", async () => {
    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Original candidate" },
      ],
    });
    const session = await startPty(fixture);
    await session.waitFor("Original candidate");
    await session.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );

    await directRuleEdit(fixture.root, CANDIDATE_A, "Concurrent human edit");
    session.send("approve\n");

    await session.waitFor("REVIEW_ITEM_CHANGED");
    await session.waitFor("Concurrent human edit");
    await session.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    session.send("approve\n");
    const result = await session.finish();

    expect(result.exitCode, result.output).toBe(0);
    const snapshot = await fixture.store.readSnapshot();
    expect(status(snapshot, CANDIDATE_A)).toBe("active");
    expect(rule(snapshot, CANDIDATE_A)).toBe("Concurrent human edit");
  }, 20_000);

  it("preserves multiple answers pasted before later prompts", async () => {
    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Approve pasted answer" },
        { createdAt: T1, id: CANDIDATE_B, rule: "Reject pasted answer" },
      ],
    });
    const session = await startPty(fixture);

    await session.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    session.send("approve\nreject\n");
    const result = await session.finish();

    expect(result.exitCode, result.output).toBe(0);
    const snapshot = await fixture.store.readSnapshot();
    expect(status(snapshot, CANDIDATE_A)).toBe("active");
    expect(status(snapshot, CANDIDATE_B)).toBe("rejected");
  }, 20_000);

  it("shows loading state and elapsed time for a slow inbox read", async () => {
    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Visible slow candidate" },
      ],
    });
    const session = await startPty(fixture, { reviewDelayMs: 2_200 });

    await session.waitFor("Loading review items (2.", 10_000);
    await session.waitFor("Visible slow candidate");
    await session.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    session.send("quit\n");
    const result = await session.finish();

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("✓ Loading review items (2.");
    expect(result.output).toContain("Review session paused");
  }, 15_000);

  it("rejects pipes and --yes without mutating canonical status", async () => {
    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Protected candidate" },
      ],
    });
    const piped = await runWithoutPty(fixture, ["review", REPO], "approve\n");
    expect(piped.exitCode).toBe(1);
    expect(piped.stderr).toContain("CLI_TTY_REQUIRED");

    const redirectedInput = await startPty(fixture, { stdinPipe: true });
    const redirectedInputResult = await redirectedInput.finish();
    expect(redirectedInputResult.exitCode).toBe(1);
    expect(redirectedInputResult.output).toContain("CLI_TTY_REQUIRED");

    const redirectedOutput = await startPty(fixture, { stdoutPipe: true });
    const redirectedOutputResult = await redirectedOutput.finish();
    expect(redirectedOutputResult.exitCode).toBe(1);
    expect(redirectedOutputResult.output).toContain("CLI_TTY_REQUIRED");

    const yes = await runWithoutPty(
      fixture,
      ["review", REPO, "--yes"],
      "approve\n",
    );
    expect(yes.exitCode).toBe(2);
    expect(yes.stderr).toContain("CLI_ARGUMENT_INVALID");
    expect(status(await fixture.store.readSnapshot(), CANDIDATE_A)).toBe(
      "proposed",
    );
  });

  it("keeps items pending on EOF, interrupt, empty inbox, and a mutation failure", async () => {
    const empty = await createFixture({});
    const emptySession = await startPty(empty);
    const emptyResult = await emptySession.finish();
    expect(emptyResult.exitCode, emptyResult.output).toBe(0);
    expect(emptyResult.output).toContain("Review inbox is empty");

    const fixture = await createFixture({
      candidates: [
        { createdAt: T0, id: CANDIDATE_A, rule: "Pending candidate" },
      ],
    });
    const eof = await startPty(fixture);
    await eof.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    eof.send("\u0004");
    const eofResult = await eof.finish();
    expect(eofResult.output).toContain("Review session paused");
    expect(outputAfterActionPrompt(eofResult.output)).not.toContain(
      "Loading review items",
    );
    expect(status(await fixture.store.readSnapshot(), CANDIDATE_A)).toBe(
      "proposed",
    );

    const interrupted = await startPty(fixture);
    await interrupted.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    interrupted.send("\u0003");
    const interruptedResult = await interrupted.finish();
    expect(interruptedResult.output).toContain("Review session paused");
    expect(outputAfterActionPrompt(interruptedResult.output)).not.toContain(
      "Loading review items",
    );
    expect(status(await fixture.store.readSnapshot(), CANDIDATE_A)).toBe(
      "proposed",
    );

    const failed = await startPty(fixture, { failAction: "approve" });
    await failed.waitFor(
      "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)",
    );
    failed.send("approve\n");
    const failedResult = await failed.finish();
    expect(failedResult.exitCode).toBe(1);
    expect(failedResult.output).toContain("injected review failure");
    expect(status(await fixture.store.readSnapshot(), CANDIDATE_A)).toBe(
      "proposed",
    );
  }, 30_000);
});

interface CandidateInput {
  readonly createdAt: string;
  readonly id: string;
  readonly rule: string;
}

interface ProposalInput {
  readonly createdAt: string;
  readonly id: string;
  readonly knowledgeId: string;
  readonly patch: KnowledgeRevisionProposal["patch"];
}

interface Fixture {
  readonly bridge: string;
  readonly root: string;
  readonly runner: string;
  readonly store: CanonicalTransactionStore;
}

async function createFixture(input: {
  readonly candidates?: readonly CandidateInput[];
  readonly proposals?: readonly ProposalInput[];
}): Promise<Fixture> {
  const root = await temporaryDirectory("rkm-review-pty-store-");
  await mkdir(join(root, "events"), { recursive: true });
  await mkdir(join(root, "knowledge"), { recursive: true });
  for (const candidate of input.candidates ?? []) {
    await writeKnowledge(root, {
      createdAt: candidate.createdAt,
      id: candidate.id,
      rule: candidate.rule,
      status: "proposed",
    });
  }
  const proposalInputs = input.proposals ?? [];
  const activeIds = [
    ...new Set(proposalInputs.map((item) => item.knowledgeId)),
  ];
  for (const [index, id] of activeIds.entries()) {
    await writeKnowledge(root, {
      createdAt: T0,
      id,
      rule: `Active target ${String(index + 1)}`,
      status: "active",
    });
  }
  if (proposalInputs.length > 0) {
    const records = proposalInputs.map((item) =>
      canonicalRecord(
        "KnowledgeRevisionProposal",
        revisionProposal(item),
        item.createdAt,
      ),
    );
    await writeFile(
      join(root, "events", "review-pty.jsonl"),
      Buffer.concat(
        records.map((record) => serializeCanonicalJsonlRecord(record)),
      ),
    );
  }
  const runnerRoot = await temporaryDirectory("rkm-review-pty-runner-");
  const runner = join(runnerRoot, "run.mjs");
  const bridge = join(runnerRoot, "pty_bridge.py");
  await writeFile(runner, runnerSource(), "utf8");
  await writeFile(bridge, ptyBridgeSource(), "utf8");
  return {
    bridge,
    root,
    runner,
    store: new CanonicalTransactionStore(root),
  };
}

async function writeKnowledge(
  root: string,
  input: {
    readonly createdAt: string;
    readonly id: string;
    readonly rule: string;
    readonly status: KnowledgeStatus;
  },
): Promise<void> {
  const path = `knowledge/${input.id}.md`;
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: "architecture",
        created_at: input.createdAt,
        id: input.id,
        origin: { type: "distilled" },
        related_ids: [],
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status: input.status,
        updated_at: input.createdAt,
      },
      `${input.rule} detail.\n`,
    ),
  );
}

function revisionProposal(input: ProposalInput): KnowledgeRevisionProposal {
  return {
    created_at: input.createdAt,
    evidence_ids: [],
    knowledge_id: input.knowledgeId,
    patch: input.patch,
    proposal_id: input.id,
    repo_id: REPO_ID,
    status: "pending",
    updated_at: input.createdAt,
  };
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  recordedAt: string,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    recorded_at: recordedAt,
    record_id: createDomainId("event"),
    record_type: recordType,
    schema_version: 1,
    transaction_id: createDomainId("transaction"),
  };
}

function runnerSource(): string {
  return `
const api = await import(process.env.RKM_INDEX_URL);
const runtime = await import(process.env.RKM_RUNTIME_URL);
const store = new api.CanonicalTransactionStore(process.env.RKM_STORE_ROOT);
const realAdmin = new api.AdminPlaneService({
  repo: ${JSON.stringify(REPO)},
  repoId: ${JSON.stringify(REPO_ID)},
  repository: store,
});
const admin = new Proxy(realAdmin, {
  get(target, property) {
    if (process.env.RKM_FAIL_ACTION === "approve" && property === "approveReviewedKnowledge") {
      return async () => { throw new Error("injected review failure"); };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const inbox = new api.ReviewInboxService({
  details: realAdmin,
  repo: ${JSON.stringify(REPO)},
  repoId: ${JSON.stringify(REPO_ID)},
  repository: store,
});
const exitCode = await api.runRepoKnowledgeCli({
  argv: process.argv.slice(2),
  doctor: { run: async () => ({ checks: [], ok: true, summary: { fail: 0, pass: 0, warn: 0 } }) },
  io: runtime.createProcessCliIo(),
  mutationServiceResolver: { resolve: async () => { throw new Error("unused mutation resolver"); } },
  operationsResolver: {
    resolve: async () => ({
      admin,
      reviewInbox: async (request) => {
        const delay = Number(process.env.RKM_REVIEW_DELAY_MS ?? "0");
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return inbox.list(request);
      },
    }),
  },
  serve: async () => undefined,
  setup: async () => { throw new Error("unused setup"); },
});
process.exitCode = exitCode;
`;
}

function ptyBridgeSource(): string {
  return `
import os
import pty
import select
import sys

saved_stdin = os.dup(sys.stdin.fileno())
saved_stdout = os.dup(sys.stdout.fileno())
pid, master = pty.fork()
if pid == 0:
    if os.environ.get("RKM_CHILD_STDIN_PIPE") == "1":
        os.dup2(saved_stdin, sys.stdin.fileno())
    if os.environ.get("RKM_CHILD_STDOUT_PIPE") == "1":
        os.dup2(saved_stdout, sys.stdout.fileno())
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

inputs = [master, sys.stdin.fileno()]
while True:
    readable, _, _ = select.select(inputs, [], [])
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if data:
            os.write(master, data)
        else:
            inputs.remove(sys.stdin.fileno())

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
}

async function directRuleEdit(
  root: string,
  id: string,
  nextRule: string,
): Promise<void> {
  const path = `knowledge/${id}.md`;
  const current = parseKnowledgeDocument(
    path,
    await readFile(join(root, path)),
  );
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      { ...current.frontmatter, rule: nextRule },
      current.body,
    ),
  );
}

async function startPty(
  fixture: Fixture,
  options: {
    readonly failAction?: string;
    readonly reviewDelayMs?: number;
    readonly stdinPipe?: boolean;
    readonly stdoutPipe?: boolean;
  } = {},
): Promise<PtySession> {
  const command = [process.execPath, fixture.runner, "review", REPO];
  const child = createPtyChild(
    [fixture.bridge, ...command],
    runnerEnvironment(fixture, options),
  );
  return new PtySession(child);
}

function createPtyChild(args: readonly string[], env: NodeJS.ProcessEnv) {
  return execa("python3", args, {
    env,
    reject: false,
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function runWithoutPty(
  fixture: Fixture,
  args: readonly string[],
  input: string,
) {
  return execa(process.execPath, [fixture.runner, ...args], {
    env: runnerEnvironment(fixture),
    input,
    reject: false,
  });
}

function runnerEnvironment(
  fixture: Fixture,
  options: {
    readonly failAction?: string;
    readonly reviewDelayMs?: number;
    readonly stdinPipe?: boolean;
    readonly stdoutPipe?: boolean;
  } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RKM_INDEX_URL: pathToFileURL(join(process.cwd(), "dist", "index.js")).href,
    RKM_RUNTIME_URL: pathToFileURL(
      join(process.cwd(), "dist", "cli-runtime.js"),
    ).href,
    RKM_STORE_ROOT: fixture.root,
    ...(options.stdinPipe === true ? { RKM_CHILD_STDIN_PIPE: "1" } : {}),
    ...(options.stdoutPipe === true ? { RKM_CHILD_STDOUT_PIPE: "1" } : {}),
    ...(options.failAction === undefined
      ? {}
      : { RKM_FAIL_ACTION: options.failAction }),
    ...(options.reviewDelayMs === undefined
      ? {}
      : { RKM_REVIEW_DELAY_MS: String(options.reviewDelayMs) }),
  };
}

class PtySession {
  private cursor = 0;
  private output = "";

  constructor(private readonly child: ReturnType<typeof createPtyChild>) {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.output += chunk.toString();
    });
  }

  send(value: string): void {
    this.child.stdin?.write(value);
  }

  async waitFor(value: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.output.indexOf(value, this.cursor);
      if (index >= 0) {
        this.cursor = index + value.length;
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${JSON.stringify(value)}. Output:\n${this.output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async finish(): Promise<{ exitCode: number; output: string }> {
    const result = await this.child;
    return { exitCode: result.exitCode ?? 0, output: this.output };
  }
}

function status(
  snapshot: Awaited<ReturnType<CanonicalTransactionStore["readSnapshot"]>>,
  id: string,
): KnowledgeStatus {
  return snapshot.domain.knowledge.find((item) => item.id === id)!.status;
}

function rule(
  snapshot: Awaited<ReturnType<CanonicalTransactionStore["readSnapshot"]>>,
  id: string,
): string {
  return snapshot.domain.knowledge.find((item) => item.id === id)!.rule;
}

function proposal(
  snapshot: Awaited<ReturnType<CanonicalTransactionStore["readSnapshot"]>>,
  id: string,
): KnowledgeRevisionProposal {
  return snapshot.domain.revisionProposals.find(
    (item) => item.proposal_id === id,
  )!;
}

function outputAfterActionPrompt(output: string): string {
  const prompt = "Action ([a]pprove / [r]eject / [s]kip / [e]dit / [q]uit)";
  return output.slice(output.lastIndexOf(prompt) + prompt.length);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
