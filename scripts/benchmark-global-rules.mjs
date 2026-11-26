/* global performance, process */
// M4-AC-032 latency benchmark for global rules in get_rules.
//
// Run locally after `npm run build`; it imports the compiled modules from
// dist/. Setup (writing and indexing 500 global rules) is excluded from the
// measured request latency.
//
// What is measured: the in-process service layer only, i.e. the wall-clock
// time of `KnowledgeReadService.getRules()` for one request, in three modes:
//   - baseline:     the global store's storage root does not exist (no global
//                   store configured on disk).
//   - empty_global: the global store is initialized and indexed but holds 0
//                   active rules.
//   - global:       the global store holds 500 active rules that all match.
// Each reported difference is `<mode> − baseline`; the M4-AC-032 threshold is
// that `global − baseline` (increase_ms) must not exceed 20 ms.
//
// What is NOT measured: MCP stdio transport, JSON-RPC framing, request/response
// (de)serialization, schema validation at the tool boundary, and process
// startup. End-to-end latency seen by an MCP client is therefore higher.
//
// Aggregation: the benchmark performs RKM_BENCH_RUNS runs (default 5). Each run
// discards RKM_BENCH_WARMUP iterations (default 10) and then records
// RKM_BENCH_SAMPLES samples per mode (default 200). Modes are interleaved per
// iteration, cycling through all 6 orderings so no mode always runs first.
// p95 is the nearest-rank p95 of a run's samples; the reported
// `<mode>_p95_ms` values are the median of the per-run p95s, which is less
// sensitive to a single noisy run than a single p95 of 100 samples.
// os.loadavg() is recorded before and after so results from a loaded machine
// can be recognized (it is always [0, 0, 0] on Windows).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, cpus, loadavg, release, tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalTransactionStore } from "../dist/canonical-transaction-store.js";
import { GlobalStore } from "../dist/global-store.js";
import { createDomainId } from "../dist/ids.js";
import { serializeKnowledgeDocument } from "../dist/knowledge-document.js";
import { KnowledgeReadService } from "../dist/knowledge-read-service.js";

const ACTIVE_RULES = 500;
const THRESHOLD_MS = 20;
const MODES = ["baseline", "empty_global", "global"];
const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function intFromEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

const runCount = intFromEnv("RKM_BENCH_RUNS", 5, 1);
const sampleCount = intFromEnv("RKM_BENCH_SAMPLES", 200, 1);
const warmup = intFromEnv("RKM_BENCH_WARMUP", 10, 0);

/** Nearest-rank percentile; for 100 samples p95 is sorted[94]. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const loadBefore = loadavg();
const root = await mkdtemp(join(tmpdir(), "rkm-global-benchmark-"));
try {
  const repository = new CanonicalTransactionStore(
    join(root, "repos", "bench"),
  );
  const options = { repo: "bench/repo", repoId: "bench", repository };
  // baseline: storage root that does not exist, so no global store is read.
  const withoutGlobal = new KnowledgeReadService({
    ...options,
    globalStore: new GlobalStore(join(root, "missing")),
  });
  // empty_global: an initialized, indexed global store with 0 active rules.
  const emptyGlobal = new GlobalStore(join(root, "empty-global"));
  await emptyGlobal.initialize();
  await emptyGlobal.reindex();
  if (!(await emptyGlobal.exists()))
    throw new Error("Expected the empty global store to exist");
  const withEmptyGlobal = new KnowledgeReadService({
    ...options,
    globalStore: emptyGlobal,
  });
  const global = new GlobalStore(root);
  await global.initialize();
  const date = "2026-01-01T00:00:00.000Z";
  const ids = Array.from({ length: ACTIVE_RULES }, () =>
    createDomainId("knowledge"),
  );
  for (const [i, id] of ids.entries()) {
    const path = `knowledge/${id}.md`;
    await writeFile(
      join(global.reference.absolutePath, path),
      serializeKnowledgeDocument(
        path,
        {
          id,
          schema_version: 1,
          revision: 1,
          repo_id: global.reference.repoId,
          status: "active",
          category: "test",
          severity: "should",
          rule: `Validate schema ${i}`,
          created_at: date,
          updated_at: date,
          scope: ["src/**"],
          origin: { type: "manual" },
          activation: { origin: "human", pinned: false },
          related_ids: [],
        },
        "Check field types.",
      ),
      { mode: 0o600 },
    );
  }
  await global.reindex();
  const withGlobal = new KnowledgeReadService({
    ...options,
    globalStore: global,
  });
  await mkdir(repository.repositoryRoot, { recursive: true, mode: 0o700 });
  const services = [withoutGlobal, withEmptyGlobal, withGlobal];
  const request = { task: "schema", filePaths: ["src/input.ts"] };
  const measurements = [];
  const perRun = [];
  for (const run of Array(runCount).keys()) {
    const samples = MODES.map(() => []);
    for (const i of Array(warmup + sampleCount).keys()) {
      const group = [];
      for (const index of ORDERS[(run + i) % ORDERS.length]) {
        const start = performance.now();
        const result = await services[index].getRules(request);
        const elapsed = performance.now() - start;
        if (result.global_read_failed)
          throw new Error(`Global read failed in ${MODES[index]} mode`);
        if (index === 2 && result.global_matched_count !== ACTIVE_RULES)
          throw new Error(`Expected ${ACTIVE_RULES} matching global rules`);
        if (index !== 2 && result.global_matched_count !== undefined)
          throw new Error(`Expected no global rules in ${MODES[index]} mode`);
        if (i >= warmup) {
          samples[index].push(elapsed);
          group.push({
            run,
            mode: MODES[index],
            elapsed_ms: elapsed,
            global_matched_count: result.global_matched_count ?? 0,
          });
        }
      }
      if (group.length) measurements.push(group);
    }
    const [baselineP95, emptyP95, globalP95] = samples.map((values) =>
      percentile(values, 95),
    );
    const [baselineMedian, emptyMedian, globalMedian] = samples.map(median);
    perRun.push({
      run,
      baseline_p95_ms: baselineP95,
      empty_global_p95_ms: emptyP95,
      global_p95_ms: globalP95,
      increase_ms: globalP95 - baselineP95,
      empty_global_increase_ms: emptyP95 - baselineP95,
      baseline_median_ms: baselineMedian,
      empty_global_median_ms: emptyMedian,
      global_median_ms: globalMedian,
    });
  }
  const loadAfter = loadavg();
  const baseline = median(perRun.map((r) => r.baseline_p95_ms));
  const emptyGlobalP95 = median(perRun.map((r) => r.empty_global_p95_ms));
  const globalP95 = median(perRun.map((r) => r.global_p95_ms));
  const increase = globalP95 - baseline;
  const build = createHash("sha256");
  for (const file of (await readdir("dist", { recursive: true }))
    .filter((f) => f.endsWith(".js"))
    .sort()) {
    build
      .update(file)
      .update("\0")
      .update(await readFile(join("dist", file)))
      .update("\0");
  }
  console.log(
    JSON.stringify(
      {
        command: "npm run build && node scripts/benchmark-global-rules.mjs",
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        build_sha256: build.digest("hex"),
        platform: process.platform,
        arch: process.arch,
        os_release: release(),
        cpu: cpus()[0]?.model,
        cpu_count: availableParallelism(),
        load_average_before: loadBefore,
        load_average_after: loadAfter,
        scope:
          "KnowledgeReadService.getRules() in-process; excludes MCP stdio/JSON-RPC transport and serialization",
        difference: "global − baseline",
        aggregation:
          "median over runs of each run's nearest-rank p95 of `samples` measurements",
        measurements,
        node: process.version,
        active_rules: ACTIVE_RULES,
        runs: runCount,
        warmup,
        samples: sampleCount,
        threshold_ms: THRESHOLD_MS,
        per_run: perRun,
        baseline_p95_ms: baseline,
        empty_global_p95_ms: emptyGlobalP95,
        global_p95_ms: globalP95,
        increase_ms: increase,
        empty_global_increase_ms: emptyGlobalP95 - baseline,
        max_run_increase_ms: Math.max(...perRun.map((r) => r.increase_ms)),
        passed: increase <= THRESHOLD_MS,
      },
      null,
      2,
    ),
  );
  if (increase > THRESHOLD_MS) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
