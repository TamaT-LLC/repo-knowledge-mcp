import { z } from "zod";

import { IngestPrResultSchema } from "./mcp-mutation-tools.js";
import { RepositoryNameSchema } from "./domain-schemas.js";

export const M1SmokeManifestSchema = z
  .object({
    pull_requests: z.array(z.number().int().positive()).length(10),
    repository: RepositoryNameSchema,
    schema_version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.pull_requests).size !== value.pull_requests.length) {
      context.addIssue({
        code: "custom",
        message: "pull_requests must contain 10 unique PR numbers",
        path: ["pull_requests"],
      });
    }
  });

export type M1SmokeManifest = z.infer<typeof M1SmokeManifestSchema>;

export interface M1SmokeCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type M1SmokeCommandExecutor = (
  argv: readonly string[],
) => Promise<M1SmokeCommandResult>;

export interface M1SmokeReport {
  readonly cases: readonly {
    readonly diagnostic?: string;
    readonly pr_number: number;
    readonly result?: {
      readonly changed_threads: number;
      readonly distilled: number;
      readonly jobs_created: number;
      readonly new_threads: number;
      readonly pending: number;
      readonly snapshot_id: string;
      readonly unchanged: number;
      readonly warnings: number;
    };
    readonly status: "fail" | "pass";
  }[];
  readonly commit: string;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
  };
  readonly finished_at: string;
  readonly idempotency: {
    readonly diagnostic?: string;
    readonly jobs_created?: number;
    readonly pr_number: number;
    readonly status: "fail" | "pass";
    readonly unchanged?: number;
  };
  readonly maintenance: {
    readonly doctor: MaintenanceGateResult;
    readonly list: MaintenanceGateResult;
    readonly reindex: MaintenanceGateResult;
  };
  readonly manifest: M1SmokeManifest;
  readonly ok: boolean;
  readonly schema_version: 1;
  readonly started_at: string;
}

interface MaintenanceGateResult {
  readonly diagnostic?: string;
  readonly status: "fail" | "pass";
  readonly summary?: Readonly<Record<string, unknown>>;
}

export interface RunM1SmokeGateOptions {
  readonly commit: string;
  readonly environment?: {
    readonly node: string;
    readonly platform: string;
  };
  readonly now?: () => Date;
}

/** Runs the reproducible 10-PR smoke sequence through an injected CLI boundary. */
export async function runM1SmokeGate(
  input: unknown,
  execute: M1SmokeCommandExecutor,
  options: RunM1SmokeGateOptions,
): Promise<M1SmokeReport> {
  const manifest = M1SmokeManifestSchema.parse(input);
  const now = options.now ?? (() => new Date());
  const startedAt = validIsoDate(now());
  const cases: M1SmokeReport["cases"][number][] = [];
  for (const prNumber of manifest.pull_requests) {
    const command = await execute([
      "ingest",
      manifest.repository,
      String(prNumber),
    ]);
    const parsed = parseJson(command.stdout);
    const result = IngestPrResultSchema.safeParse(parsed);
    if (command.exitCode !== 0 || !result.success) {
      cases.push({
        diagnostic: diagnostic(command, result.error?.message),
        pr_number: prNumber,
        status: "fail",
      });
      continue;
    }
    cases.push({
      pr_number: prNumber,
      result: {
        changed_threads: result.data.changed_threads,
        distilled: result.data.distilled,
        jobs_created: result.data.jobs_created,
        new_threads: result.data.new_threads,
        pending: result.data.pending,
        snapshot_id: result.data.snapshot_id,
        unchanged: result.data.unchanged,
        warnings: result.data.warnings.length,
      },
      status: "pass",
    });
  }

  const repeatedPr = manifest.pull_requests[0]!;
  const repeated = await execute([
    "ingest",
    manifest.repository,
    String(repeatedPr),
  ]);
  const repeatedResult = IngestPrResultSchema.safeParse(
    parseJson(repeated.stdout),
  );
  const idempotent =
    repeated.exitCode === 0 &&
    repeatedResult.success &&
    repeatedResult.data.jobs_created === 0 &&
    repeatedResult.data.changed_threads === 0 &&
    repeatedResult.data.new_threads === 0;
  const idempotency: M1SmokeReport["idempotency"] = idempotent
    ? {
        jobs_created: repeatedResult.data.jobs_created,
        pr_number: repeatedPr,
        status: "pass",
        unchanged: repeatedResult.data.unchanged,
      }
    : {
        diagnostic: diagnostic(repeated, repeatedResult.error?.message),
        pr_number: repeatedPr,
        status: "fail",
      };

  const list = await maintenance(execute, ["list", manifest.repository]);
  const reindex = await maintenance(execute, ["reindex", manifest.repository]);
  const doctor = await maintenance(execute, ["doctor", manifest.repository], {
    requireOk: true,
  });
  const maintenanceResults = { doctor, list, reindex };
  const ok =
    cases.every((entry) => entry.status === "pass") &&
    idempotency.status === "pass" &&
    Object.values(maintenanceResults).every((entry) => entry.status === "pass");

  return {
    cases,
    commit: nonEmpty(options.commit, "commit"),
    environment: options.environment ?? {
      node: process.versions.node,
      platform: process.platform,
    },
    finished_at: validIsoDate(now()),
    idempotency,
    maintenance: maintenanceResults,
    manifest,
    ok,
    schema_version: 1,
    started_at: startedAt,
  };
}

async function maintenance(
  execute: M1SmokeCommandExecutor,
  argv: readonly string[],
  options: { readonly requireOk?: boolean } = {},
): Promise<MaintenanceGateResult> {
  const command = await execute(argv);
  const output = parseJson(command.stdout);
  const outputRecord = asRecord(output);
  const success =
    command.exitCode === 0 &&
    outputRecord !== null &&
    (options.requireOk !== true || outputRecord.ok === true);
  return success
    ? {
        status: "pass",
        summary:
          asRecord(outputRecord.summary) ?? summarizeMaintenance(outputRecord),
      }
    : { diagnostic: diagnostic(command), status: "fail" };
}

function summarizeMaintenance(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  for (const key of ["evidence", "jobs", "knowledge", "repo", "submissions"]) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  if (Array.isArray(value.knowledge)) {
    summary.knowledge = value.knowledge.length;
  }
  if (Array.isArray(value.revision_proposals)) {
    summary.revision_proposals = value.revision_proposals.length;
  }
  return summary;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function diagnostic(
  command: M1SmokeCommandResult,
  validation?: string,
): string {
  return [`exit=${String(command.exitCode)}`, validation, command.stderr.trim()]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("; ")
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .slice(0, 2_048);
}

function validIsoDate(now: Date): string {
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("now returned Invalid Date");
  return now.toISOString();
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new TypeError(`${field} must not be empty`);
  return normalized;
}
