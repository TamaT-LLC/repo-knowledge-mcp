/* global process */
// Benchmark for compileWhenHot (src/zod-compile-when-hot.ts): what compiling
// each marked schema costs and saves, and whether the marks and the threshold
// still hold.
//
// Run locally after `npm run build`: node scripts/benchmark-zod-compile.mjs
// To judge a new candidate, mark it with compileWhenHot, run this, and keep the
// mark only if the schema is at least 1.5× faster compiled.
//
// Stage 1 runs the test suite (the suites `npm run test:compiled` runs, one
// file at a time) with benchmark-zod-compile.setup.mjs. That setup names every
// mark by where it is defined, records the inputs the suite passes it, and
// after each file measures each mark on those inputs:
//   - runtime_us / compiled_us: mean time per safeParse, on valid inputs and on
//     invalid ones separately. A compiled invalid input runs the compiled check
//     and then the runtime parser, so it is slower; valid inputs decide.
//   - compile_ms: median time of three z.compile() calls in a warm process.
// A mark appears once per test file that uses it; the report takes the median
// over files. The inputs are whatever the tests pass, so the figures are a
// guide, not a production profile.
//
// Stage 2 times reduceDomainRecords() (the projection rebuild's parse step)
// from dist/, with compileWhenHot off and on, over histories of
// RKM_BENCH_PRS pull requests (default "200,1000") built from the recorded
// observation payloads.
//
// Figures for small schemas move between runs; for a mark near 1.5×, run this
// twice and keep the mark only if both runs clear it.
//
// Output: one JSON object. `summary.below_1_5x` lists marks whose valid inputs
// are less than 1.5× faster compiled; `summary.no_inputs` lists marks the
// suite never validated, which this cannot measure. os.loadavg() is recorded
// before and after, as in benchmark-global-rules.mjs.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, loadavg, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const THRESHOLD_USES = 500;
const MIN_RATIO = 1.5;
const prsList = (process.env.RKM_BENCH_PRS ?? "200,1000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isSafeInteger(value) && value > 0);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const round = (value, digits = 2) =>
  value === null ? null : Number(value.toFixed(digits));

const loadBefore = loadavg();
const work = await mkdtemp(join(tmpdir(), "rkm-zod-bench-"));
const out = join(work, "marks.jsonl");
try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "scripts/benchmark-zod-compile.vitest.config.mjs",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, RKM_ZOD_BENCH_OUT: out },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  const byName = new Map();
  for (const line of (await readFile(out, "utf8")).split("\n")) {
    if (line === "") continue;
    const row = JSON.parse(line);
    const rows = byName.get(row.name) ?? [];
    rows.push(row);
    byName.set(row.name, rows);
  }

  const timing = (rows, key) => {
    const measured = rows.map((row) => row[key]).filter(Boolean);
    if (measured.length === 0) return null;
    const runtimeUs = median(measured.map((row) => row.runtime_us));
    const compiledUs = median(measured.map((row) => row.compiled_us));
    return {
      compiled_us: round(compiledUs, 3),
      inputs: measured.reduce((sum, row) => sum + row.inputs, 0),
      ratio: round(runtimeUs / compiledUs),
      runtime_us: round(runtimeUs, 3),
    };
  };

  const schemas = [];
  const noInputs = [];
  for (const [name, rows] of byName) {
    const used = rows.filter((row) => row.inputs > 0);
    if (used.length === 0) {
      noInputs.push(name);
      continue;
    }
    const compileMs = median(used.map((row) => row.compile_ms));
    const valid = timing(used, "valid");
    const saveUs = valid === null ? null : valid.runtime_us - valid.compiled_us;
    schemas.push({
      break_even_uses:
        saveUs !== null && saveUs > 0
          ? Math.round((compileMs * 1000) / saveUs)
          : null,
      compile_ms: round(compileMs, 3),
      files: used.length,
      invalid: timing(used, "invalid"),
      name,
      valid,
    });
  }
  schemas.sort((a, b) => (b.valid?.ratio ?? 0) - (a.valid?.ratio ?? 0));
  const breakEvens = schemas
    .map((schema) => schema.break_even_uses)
    .filter((value) => value !== null);

  const payloads = `${out}.payloads`;
  const reduce = prsList.flatMap((prs) =>
    ["runtime", "compiled"].map((mode) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(ROOT, "scripts", "benchmark-zod-compile.reduce.mjs"),
            payloads,
            String(prs),
            mode,
          ],
          { cwd: ROOT, encoding: "utf8" },
        ),
      ),
    ),
  );

  console.log(
    JSON.stringify(
      {
        environment: {
          cpu: cpus()[0]?.model ?? "unknown",
          loadavg_after: loadavg(),
          loadavg_before: loadBefore,
          node: process.version,
          os_release: release(),
        },
        reduce_domain_records: reduce.map((row) => ({
          ...row,
          first_ms: round(row.first_ms),
          steady_median_ms: round(row.steady_median_ms),
        })),
        schemas,
        summary: {
          below_1_5x: schemas
            .filter((schema) => (schema.valid?.ratio ?? 0) < MIN_RATIO)
            .map((schema) => schema.name),
          break_even_median_uses:
            breakEvens.length === 0 ? null : median(breakEvens),
          break_even_p75_uses:
            breakEvens.length === 0 ? null : percentile(breakEvens, 0.75),
          marks: byName.size,
          measured: schemas.length,
          no_inputs: noInputs.sort(),
          threshold_uses: THRESHOLD_USES,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(work, { force: true, recursive: true });
}
