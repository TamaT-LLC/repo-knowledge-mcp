/* global performance, process */
// Vitest setup for scripts/benchmark-zod-compile.mjs; see that file.
//
// It enables compileWhenHot before any schema module loads, so every mark is
// installed (and named by where it is defined) as its module loads. Each mark
// keeps the runtime parser and records the inputs the suite passes it. After
// each test file, every mark that received inputs is measured on them:
// runtime versus z.compile() per call, and the cost of z.compile() itself.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll } from "vitest";
import { z } from "zod";

import { enableCompileWhenHot } from "../src/zod-compile-when-hot.js";

const OUT = process.env.RKM_ZOD_BENCH_OUT;
if (OUT === undefined) throw new Error("RKM_ZOD_BENCH_OUT is not set");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_INPUTS = 64;
const MIN_SAMPLE_MS = 20;
/** Payload schemas whose inputs the reduceDomainRecords stage reuses. */
const PAYLOADS = new Set([
  "src/domain-schemas.ts#CommentObservationSchema",
  "src/domain-schemas.ts#PullRequestObservationSchema",
  "src/domain-schemas.ts#PullRequestSnapshotSchema",
  "src/domain-schemas.ts#ThreadObservationSchema",
]);

const sources = new Map();
function sourceLines(file) {
  let lines = sources.get(file);
  if (lines === undefined) {
    lines = readFileSync(file, "utf8").split("\n");
    sources.set(file, lines);
  }
  return lines;
}

/**
 * `file#Name` of the module-level const the schema is assigned to. Frames
 * inside a factory (a function the const calls) are skipped for the caller.
 */
function definitionName(stack) {
  for (const line of stack.split("\n")) {
    const frame = /((?:file:\/\/)?\/[^\s():]+\.ts):(\d+):\d+\)?$/u.exec(line);
    if (frame === null) continue;
    const file = frame[1].replace(/^file:\/\//u, "");
    if (!file.includes("/src/") || file.endsWith("zod-compile-when-hot.ts")) {
      continue;
    }
    const lines = sourceLines(file);
    for (let index = Number(frame[2]) - 1; index >= 0; index -= 1) {
      const text = lines[index] ?? "";
      const name = /^(?:export )?const (\w+)/u.exec(text);
      if (name !== null) return `${relative(ROOT, file)}#${name[1]}`;
      if (/^(?:export )?(?:async )?function /u.test(text)) break;
    }
  }
  return "unknown";
}

const marks = new Map();

enableCompileWhenHot({
  afterUses: 0,
  onInstall(schema) {
    marks.set(schema, {
      inputs: [],
      name: definitionName(new Error().stack ?? ""),
    });
  },
  // Never compiles: records each input and keeps the runtime result.
  compile(schema, runtime) {
    const mark = marks.get(schema);
    if (mark !== undefined) mark.runtime = runtime;
    const record = (input) => {
      if (mark === undefined || mark.inputs.length >= MAX_INPUTS) return;
      try {
        mark.inputs.push(structuredClone(input));
      } catch {
        // An input that cannot be cloned is left out of the measurement.
      }
    };
    return {
      parse: (data, params) => {
        record(data);
        return runtime.parse(data, params);
      },
      safeParse: (data, params) => {
        record(data);
        return runtime.safeParse(data, params);
      },
      validate: (data, params) => {
        record(data);
        return runtime.validate(data, params);
      },
      "~standard": {
        validate: (value, options) => {
          record(value);
          return runtime["~standard"].validate(value, options);
        },
      },
    };
  },
});

/** Mean microseconds per call of `run` over the inputs, after a warm-up. */
function microsecondsPerCall(run, inputs) {
  for (let round = 0; round < 20; round += 1) {
    for (const input of inputs) run(input);
  }
  let calls = 0;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < MIN_SAMPLE_MS) {
    for (const input of inputs) run(input);
    calls += inputs.length;
    elapsed = performance.now() - start;
  }
  return (elapsed * 1000) / calls;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

afterAll(() => {
  const lines = [];
  for (const [schema, mark] of marks) {
    if (mark.inputs.length === 0) {
      lines.push({ inputs: 0, name: mark.name });
      continue;
    }
    // Put the schema's own parsers back first: z.compile() falls back to the
    // schema's current methods, which are still the recording ones.
    const { runtime } = mark;
    const target = schema;
    target.parse = runtime.parse;
    target.safeParse = runtime.safeParse;
    target.validate = runtime.validate;
    target["~standard"] = runtime["~standard"];
    const compileMs = median(
      [0, 1, 2].map(() => {
        const start = performance.now();
        z.compile(schema);
        return performance.now() - start;
      }),
    );
    const compiled = z.compile(schema);
    // Most production inputs are valid; an invalid one runs the compiled check
    // and then the runtime parser for the issues, so it is measured apart.
    const valid = mark.inputs.filter(
      (input) => runtime.safeParse(input).success,
    );
    const invalid = mark.inputs.filter(
      (input) => !runtime.safeParse(input).success,
    );
    const timing = (inputs) =>
      inputs.length === 0
        ? null
        : {
            compiled_us: microsecondsPerCall(
              (input) => compiled.safeParse(input),
              inputs,
            ),
            inputs: inputs.length,
            runtime_us: microsecondsPerCall(
              (input) => runtime.safeParse(input),
              inputs,
            ),
          };
    lines.push({
      compile_ms: compileMs,
      inputs: mark.inputs.length,
      invalid: timing(invalid),
      name: mark.name,
      valid: timing(valid),
    });
    if (PAYLOADS.has(mark.name) && valid.length > 0) {
      const dir = `${OUT}.payloads`;
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${mark.name.split("#")[1]}.jsonl`),
        valid.map((input) => `${JSON.stringify(input)}\n`).join(""),
      );
    }
  }
  appendFileSync(
    OUT,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  );
});
