import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadDistillationPrompt } from "./distillation-prompt.js";
import { TrustConfigSchema } from "./domain-schemas.js";
import {
  buildUnreadableInputOutcome,
  runQualityGate,
  type QualityGateRunOutcome,
} from "./quality-gate-runner.js";

const USAGE = [
  "Usage:",
  "  quality-gate-cli [--artifact <baseline.json>] [--thresholds <thresholds.json>]",
  "                   [--corpus <corpus.json>] [--recorded <recorded-predictions.json>]",
  "                   [--prompt <distill.md>] [--trust <trust.json>]",
  "",
  "Runs the offline M2 quality gate from recorded predictions only. No network",
  "access and no provider credential is required. The machine-readable report",
  "is always written to stdout.",
  "",
  "Exit codes:",
  "  0  every metric is at or above its reviewed minimum",
  "  1  at least one metric dropped below its minimum",
  "  2  integrity failure (invalid input, baseline mismatch, fixture drift)",
].join("\n");

const DEFAULT_ARTIFACT_PATH = "test/fixtures/golden/m2-provider-baseline.json";
const DEFAULT_CORPUS_PATH = "test/fixtures/golden/m2-anonymized-corpus.json";
const DEFAULT_PROMPT_PATH = "prompts/distill.md";
const DEFAULT_RECORDED_PATH =
  "test/fixtures/golden/m2-recorded-predictions.json";
const DEFAULT_THRESHOLDS_PATH =
  "test/fixtures/golden/m2-quality-thresholds.json";
const USAGE_EXIT_CODE = 2;

interface ParsedArguments {
  readonly artifactPath: string;
  readonly corpusPath: string;
  readonly promptPath: string;
  readonly recordedPath: string;
  readonly thresholdsPath: string;
  readonly trustPath?: string;
}

class UsageError extends Error {}

let outcome: QualityGateRunOutcome;
try {
  const parsed = parseArguments(process.argv.slice(2));
  outcome = await runParsedQualityGate(parsed);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exit(USAGE_EXIT_CODE);
  }
  outcome = buildUnreadableInputOutcome(
    error instanceof Error ? error.message : String(error),
  );
}
process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
process.exitCode = outcome.exitCode;

async function runParsedQualityGate(
  parsed: ParsedArguments,
): Promise<QualityGateRunOutcome> {
  const [artifact, corpus, recordedPredictions, thresholds] = await Promise.all(
    [
      readJson(parsed.artifactPath),
      readJson(parsed.corpusPath),
      readJson(parsed.recordedPath),
      readJson(parsed.thresholdsPath),
    ],
  );
  const prompt = await loadDistillationPrompt(resolve(parsed.promptPath));
  const trust = TrustConfigSchema.parse(
    parsed.trustPath === undefined ? {} : await readJson(parsed.trustPath),
  );
  return runQualityGate({
    artifact,
    corpus,
    prompt,
    recordedPredictions,
    thresholds,
    trust,
  });
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let artifactPath = DEFAULT_ARTIFACT_PATH;
  let corpusPath = DEFAULT_CORPUS_PATH;
  let promptPath = DEFAULT_PROMPT_PATH;
  let recordedPath = DEFAULT_RECORDED_PATH;
  let thresholdsPath = DEFAULT_THRESHOLDS_PATH;
  let trustPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--artifact":
        artifactPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--corpus":
        corpusPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--prompt":
        promptPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--recorded":
        recordedPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--thresholds":
        thresholdsPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--trust":
        trustPath = requireValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new UsageError(`unknown argument ${argument}`);
    }
  }
  return {
    artifactPath,
    corpusPath,
    promptPath,
    recordedPath,
    thresholdsPath,
    ...(trustPath === undefined ? {} : { trustPath }),
  };
}

function requireValue(
  argv: readonly string[],
  index: number,
  argument: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${argument} requires a value`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}
