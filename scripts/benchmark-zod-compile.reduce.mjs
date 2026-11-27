/* global performance, process */
// Child process for scripts/benchmark-zod-compile.mjs; see that file.
//
// Usage: node benchmark-zod-compile.reduce.mjs <payloadDir> <prs> <mode>
// Builds a canonical history of <prs> pull requests from the payloads the
// suite recorded (per PR: 1 PR, 1 snapshot, 5 threads, 15 comments) and times
// reduceDomainRecords() over it, with compileWhenHot off (`runtime`) or on
// (`compiled`). Prints one JSON line.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reduceDomainRecords } from "../dist/domain-projection.js";
import { enableCompileWhenHot } from "../dist/zod-compile-when-hot.js";

const [payloadDir, prsArgument, mode] = process.argv.slice(2);
const prs = Number(prsArgument);
const MIX = [
  ["PullRequestObserved", "PullRequestObservationSchema", 1],
  ["PullRequestSnapshotCompleted", "PullRequestSnapshotSchema", 1],
  ["ThreadObserved", "ThreadObservationSchema", 5],
  ["CommentObserved", "CommentObservationSchema", 15],
];
const STEADY_RUNS = 15;

const records = [];
for (const [recordType, schema, perPr] of MIX) {
  const pool = readFileSync(join(payloadDir, `${schema}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (let pr = 0; pr < prs; pr += 1) {
    for (let index = 0; index < perPr; index += 1) {
      records.push({
        payload: pool[(pr * perPr + index) % pool.length],
        record_id: `r${records.length}`,
        record_type: recordType,
        recorded_at: "2026-01-01T00:00:00.000Z",
        schema_version: 1,
        transaction_id: "t",
      });
    }
  }
}

if (mode === "compiled") enableCompileWhenHot();

let start = performance.now();
reduceDomainRecords(records);
const firstMs = performance.now() - start;
const steady = [];
for (let run = 0; run < STEADY_RUNS; run += 1) {
  start = performance.now();
  reduceDomainRecords(records);
  steady.push(performance.now() - start);
}
steady.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    first_ms: firstMs,
    mode,
    prs,
    records: records.length,
    steady_median_ms: steady[Math.floor(STEADY_RUNS / 2)],
  }),
);
