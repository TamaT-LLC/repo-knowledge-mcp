import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY = "owner/repository";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HASH = `sha256:${"a".repeat(64)}`;
const children: StdioProcessClient[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((client) => client.close()));
});

describe("M1 real stdio MCP E2E", () => {
  it("lists and successfully calls every tool without stdout contamination", async () => {
    const client = new StdioProcessClient();
    children.push(client);
    await client.start();

    const initialized = await client.request("initialize", {
      capabilities: {},
      clientInfo: { name: "m1-stdio-gate", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    });
    expect(initialized).toMatchObject({
      result: { serverInfo: { name: "repo-knowledge", version: "0.3.0" } },
    });
    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    const toolNames = readTools(listed).sort();
    expect(toolNames).toEqual([
      "add_knowledge",
      "get_knowledge",
      "get_rules",
      "ingest_pr",
      "prepare_distillation",
      "record_outcome",
      "search_knowledge",
      "stats",
      "submit_distillation",
      "sync_repo",
      "update_knowledge",
    ]);

    const calls: Readonly<Record<string, Record<string, unknown>>> = {
      add_knowledge: {
        category: "architecture",
        detail: "stdio fixture detail",
        repo: REPOSITORY,
        rule: "Keep stdio clean",
        scope: ["src/**"],
        severity: "must",
      },
      get_knowledge: { id: KNOWLEDGE_ID, repo: REPOSITORY },
      get_rules: { file_paths: ["src/index.ts"], repo: REPOSITORY },
      ingest_pr: { pr_number: 7, repo: REPOSITORY },
      prepare_distillation: { repo: REPOSITORY },
      record_outcome: {
        at: "2026-08-07T00:00:00.000Z",
        context: { task_id: "m1-stdio-gate" },
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        knowledge_id: KNOWLEDGE_ID,
        note: "observed the stdio fixture result",
        outcome: "applied",
        repo: REPOSITORY,
        result_observed: true,
      },
      search_knowledge: { query: "stdio", repo: REPOSITORY },
      stats: { repo: REPOSITORY },
      submit_distillation: {
        candidates: [],
        job_id: JOB_ID,
        lease_generation: 1,
        lease_token: "lease-token",
        phase: "extract",
        repo: REPOSITORY,
        request_schema_version: 1,
        skip_reason: "typo",
        submission_id: "stdio-submission",
        thread_fingerprint: HASH,
      },
      sync_repo: { repo: REPOSITORY, since: "2026-08-01T00:00:00.000Z" },
      update_knowledge: {
        expected_etag: "a".repeat(64),
        expected_revision: 1,
        id: KNOWLEDGE_ID,
        patch: { rule: "Keep every stdio frame valid JSON-RPC" },
        repo: REPOSITORY,
      },
    };
    for (const name of toolNames) {
      const response = await client.request("tools/call", {
        arguments: calls[name],
        name,
      });
      expect(response).not.toHaveProperty("error");
      expect(response).toMatchObject({
        result: { content: expect.any(Array) },
      });
      expect((response.result as { isError?: boolean }).isError).not.toBe(true);
    }

    expect(client.invalidStdout).toEqual([]);
    expect(client.messages.every(isJsonRpcMessage)).toBe(true);
    expect(client.stderr).toBe("");
  });
});

class StdioProcessClient {
  readonly invalidStdout: string[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  stderr = "";

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(value: Record<string, unknown>): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stdoutBuffer = "";

  async start(): Promise<void> {
    this.child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", SERVER_SOURCE],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.once("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      const error = new Error(
        `stdio fixture exited early (${String(code)}, ${String(signal)})`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      this.child!.once("spawn", resolve);
      this.child!.once("error", reject);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 5_000);
      this.pending.set(id, { reject, resolve, timer });
    });
    this.send({ id, jsonrpc: "2.0", method, params });
    return response;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (
      child === null ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.child === null) throw new Error("stdio fixture is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value)) throw new TypeError("frame is not an object");
        message = value;
      } catch {
        this.invalidStdout.push(line);
        continue;
      }
      this.messages.push(message);
      const id = message.id;
      if (typeof id !== "number") continue;
      const pending = this.pending.get(id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(message);
    }
  }
}

function readTools(response: Record<string, unknown>): string[] {
  const result = asRecord(response.result);
  if (!Array.isArray(result.tools)) throw new TypeError("tools/list failed");
  return result.tools.map((tool) => {
    const name = asRecord(tool).name;
    if (typeof name !== "string") throw new TypeError("tool has no name");
    return name;
  });
}

function isJsonRpcMessage(value: Record<string, unknown>): boolean {
  return value.jsonrpc === "2.0";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("expected an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SERVER_SOURCE = String.raw`
import { serveRepoKnowledgeStdio } from "./dist/index.js";

const repo = "owner/repository";
const knowledgeId = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const snapshotId = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const read = {
  async getRules() {
    return {
      matched_count: 1,
      readiness: {
        next_action: "Use the returned rules.",
        state: "ready",
      },
      repo,
      rules: [{
        evidence_count: 1,
        id: knowledgeId,
        match_reasons: [{ type: "global" }],
        rule: "Keep stdio clean",
        severity: "must",
        violation_count: 0,
      }],
      truncated: false,
    };
  },
  async searchKnowledge(request) {
    return {
      mode: "fts",
      query: request.query,
      repo,
      results: [{
        applied_count: 0,
        category: "architecture",
        detail: "stdio fixture detail",
        etag: "a".repeat(64),
        evidence_count: 1,
        id: knowledgeId,
        revision: 1,
        rule: "Keep stdio clean",
        scope: ["src/**"],
        score: 1,
        severity: "must",
        sources: ["human"],
        violation_count: 0,
      }],
    };
  },
  async getStats() {
    return {
      buckets: null,
      canonical_digest: "a".repeat(64),
      evidence: {
        by_source: { bugbot: 0, devin: 0, greptile: 0, human: 1, other: 0 },
        by_status: { active: 1, superseded: 0, withdrawn: 0 },
        eligible_for_count: 1,
        total: 1,
      },
      jobs: {
        by_state: {
          awaiting_finalize: 0,
          done: 0,
          failed: 0,
          pending: 1,
          processing: 0,
          skipped: 0,
        },
        total: 1,
      },
      knowledge: {
        by_category: {
          architecture: 1,
          docs: 0,
          "error-handling": 0,
          naming: 0,
          other: 0,
          perf: 0,
          security: 0,
          style: 0,
          test: 0,
        },
        by_severity: { consider: 0, must: 1, should: 0 },
        by_status: {
          active: 1,
          deprecated: 0,
          proposed: 0,
          rejected: 0,
          stale: 0,
        },
        total: 1,
      },
      operations: {
        failed_jobs: 0,
        last_sync_checkpoint_at: null,
        pending_jobs: 1,
      },
      outcomes: {
        by_type: {
          applied: 0,
          false_positive: 0,
          not_applicable: 0,
          violated: 0,
        },
        total: 0,
      },
      repo,
      stats_schema_version: 1,
      sync: { last_checkpoint: null },
      window: { bucket: "total", since: null, timezone: "UTC", until: null },
    };
  },
  async getKnowledge() {
    return {
      evidence: [],
      knowledge: {
        applied_count: 0,
        code_example: null,
        detail: "stdio fixture detail",
        etag: "a".repeat(64),
        evidence_count: 1,
        frontmatter: {
          id: knowledgeId,
          repo_id: "R_repository",
          revision: 1,
          schema_version: 1,
        },
        id: knowledgeId,
        revision: 1,
        sources: ["human"],
        violation_count: 0,
      },
      next_cursor: null,
      repo,
    };
  },
};
const mutation = {
  async ingestPullRequest() {
    return {
      changed_threads: 0,
      distilled: 0,
      jobs_created: 1,
      new_threads: 1,
      pending: 1,
      repo_id: "R_repository",
      snapshot_id: snapshotId,
      unchanged: 0,
      warnings: [],
    };
  },
  async prepareDistillation() {
    return {
      instructions: ["Enable both host-assisted settings intentionally."],
      jobs: [],
      missing_settings: [
        "hostAssistedDistillation.allowReviewContentTransmission",
        "hostAssistedDistillation.enabled",
      ],
      required_settings: {
        "hostAssistedDistillation.allowReviewContentTransmission": true,
        "hostAssistedDistillation.enabled": true,
      },
      state: "disabled",
    };
  },
  async recordOutcome() {
    return {
      applied_count: 1,
      event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      knowledge_id: knowledgeId,
      outcome: "applied",
      replayed: false,
      violation_count: 0,
    };
  },
  async submitExtract() {
    return {
      skip_reason: "typo",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    };
  },
  async submitFinalize() {
    return {
      accepted: true,
      created_proposed: [],
      merged_evidence: [],
      revision_proposals: [],
    };
  },
  async syncRepo() {
    return {
      discovered: 1,
      failed: 0,
      failures: [],
      ingested: 1,
      jobs_created: 1,
      next_cursor: {
        last_pr_number: 7,
        last_updated_at: "2026-08-06T00:00:00.000Z",
        repo_id: "R_repository",
        version: 1,
      },
      unchanged: 0,
    };
  },
  async addKnowledge() {
    return {
      etag: "a".repeat(64),
      id: knowledgeId,
      origin: "manual",
      repo,
      revision: 1,
      status: "proposed",
    };
  },
  async updateKnowledge() {
    return {
      current_etag: "a".repeat(64),
      current_revision: 1,
      knowledge_id: knowledgeId,
      proposal_id: "proposal-stdio",
      repo,
      status: "pending",
    };
  },
};
serveRepoKnowledgeStdio({
  mutationServiceResolver: { async resolve() { return mutation; } },
  readServiceResolver: { async resolve() { return read; } },
});
`;
