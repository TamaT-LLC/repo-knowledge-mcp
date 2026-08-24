import { describe, expect, it } from "vitest";

import {
  M1SmokeManifestSchema,
  runM1SmokeGate,
  type M1SmokeCommandExecutor,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = new Date("2026-08-06T00:00:00.000Z");

describe("M1 10-PR smoke gate", () => {
  it("records ingest, idempotency, reindex, list, and doctor gates", async () => {
    let ingestCalls = 0;
    const execute: M1SmokeCommandExecutor = async (argv) => {
      if (argv[0] === "ingest") {
        ingestCalls += 1;
        return success({
          changed_threads: 0,
          distilled: 0,
          jobs_created: ingestCalls <= 10 ? 1 : 0,
          new_threads: ingestCalls <= 10 ? 1 : 0,
          pending: ingestCalls <= 10 ? 1 : 0,
          repo_id: "R_repository",
          snapshot_id: SNAPSHOT_ID,
          unchanged: ingestCalls <= 10 ? 0 : 1,
          warnings: [],
        });
      }
      if (argv[0] === "doctor") {
        return success({
          checks: [],
          ok: true,
          summary: { fail: 0, pass: 20, warn: 0 },
        });
      }
      if (argv[0] === "reindex") {
        return success({
          evidence: 10,
          jobs: 10,
          knowledge: 0,
          repo: REPOSITORY,
          submissions: 0,
        });
      }
      return success({
        knowledge: [],
        repo: REPOSITORY,
        revision_proposals: [],
      });
    };

    const report = await runM1SmokeGate(manifest(), execute, {
      commit: "abc123",
      environment: { node: "24.4.0", platform: "linux" },
      now: () => NOW,
    });

    expect(report).toMatchObject({
      cases: expect.arrayContaining([
        expect.objectContaining({ pr_number: 1, status: "pass" }),
        expect.objectContaining({ pr_number: 10, status: "pass" }),
      ]),
      commit: "abc123",
      environment: { node: "24.4.0", platform: "linux" },
      finished_at: NOW.toISOString(),
      idempotency: {
        jobs_created: 0,
        pr_number: 1,
        status: "pass",
        unchanged: 1,
      },
      maintenance: {
        doctor: { status: "pass", summary: { fail: 0, pass: 20, warn: 0 } },
        list: {
          status: "pass",
          summary: { knowledge: 0, revision_proposals: 0 },
        },
        reindex: { status: "pass", summary: { evidence: 10, jobs: 10 } },
      },
      ok: true,
      schema_version: 1,
      started_at: NOW.toISOString(),
    });
    expect(report.cases).toHaveLength(10);
    expect(ingestCalls).toBe(11);
  });

  it("fails the report for a malformed command result", async () => {
    const execute: M1SmokeCommandExecutor = async (argv) =>
      argv[0] === "doctor"
        ? success({ ok: false, summary: { fail: 1, pass: 0, warn: 0 } })
        : { exitCode: 1, stderr: "fixture failure", stdout: "not-json" };

    const report = await runM1SmokeGate(manifest(), execute, {
      commit: "abc123",
      now: () => NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.cases.every((entry) => entry.status === "fail")).toBe(true);
    expect(report.idempotency).toMatchObject({ status: "fail" });
    expect(report.maintenance.doctor).toMatchObject({ status: "fail" });
  });

  it("requires exactly 10 unique PRs", () => {
    expect(() =>
      M1SmokeManifestSchema.parse({
        pull_requests: Array.from({ length: 10 }, () => 1),
        repository: REPOSITORY,
        schema_version: 1,
      }),
    ).toThrow(/10 unique PR numbers/u);
  });
});

function manifest() {
  return {
    pull_requests: Array.from({ length: 10 }, (_, index) => index + 1),
    repository: REPOSITORY,
    schema_version: 1 as const,
  };
}

function success(output: unknown) {
  return {
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify(output),
  };
}
