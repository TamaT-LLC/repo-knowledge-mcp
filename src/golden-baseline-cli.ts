import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AnthropicProviderAdapter } from "./anthropic-provider.js";
import { loadDistillationPrompt } from "./distillation-prompt.js";
import { TrustConfigSchema } from "./domain-schemas.js";
import {
  GoldenBaselineCaptureError,
  captureProviderGoldenBaseline,
  createAdapterPredictionProvider,
  createRecordedPredictionProvider,
  type BaselinePredictionProvider,
} from "./golden-baseline.js";

const USAGE = [
  "Usage:",
  "  golden-baseline-cli --corpus <corpus.json> --replay <recorded-predictions.json> [--out <artifact.json>]",
  "  golden-baseline-cli --corpus <corpus.json> --live --model <model> --consent-cloud-transmission [--out <artifact.json>]",
  "",
  "Options:",
  "  --corpus <path>               anonymized thread corpus fixture (required)",
  "  --replay <path>               replay recorded predictions; no network access",
  "  --live                        call the logged-in Claude Code subscription",
  "  --consent-cloud-transmission  explicit opt-in required for --live",
  "  --model <model>               Claude Code subscription model id (required for --live)",
  "  --prompt <path>               distillation prompt (default prompts/distill.md)",
  "  --trust <path>                trust config JSON for the trust policy digest",
  "  --out <path>                  artifact output file (default stdout)",
].join("\n");

const DEFAULT_PROMPT_PATH = "prompts/distill.md";

interface ParsedArguments {
  readonly consent: boolean;
  readonly corpusPath: string;
  readonly mode: "live" | "replay";
  readonly model?: string;
  readonly outPath?: string;
  readonly promptPath: string;
  readonly replayPath?: string;
  readonly trustPath?: string;
}

class UsageError extends Error {}

try {
  const parsed = parseArguments(process.argv.slice(2));
  assertLiveModePreconditions(parsed);
  const corpus = await readJson(parsed.corpusPath);
  const prompt = await loadDistillationPrompt(resolve(parsed.promptPath));
  const trust = TrustConfigSchema.parse(
    parsed.trustPath === undefined ? {} : await readJson(parsed.trustPath),
  );
  const { measuredAt, predictionProvider } = await buildProvider(
    parsed,
    corpus,
  );
  const artifact = await captureProviderGoldenBaseline({
    corpus,
    measuredAt,
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    predictionProvider,
    prompt,
    transmission: {
      cloudConsent: parsed.consent,
      mode: parsed.mode,
    },
    trust,
  });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (parsed.outPath === undefined) {
    process.stdout.write(serialized);
  } else {
    await writeFile(resolve(parsed.outPath), serialized, "utf8");
    process.stderr.write(
      `baseline artifact written to ${resolve(parsed.outPath)}\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else if (
    error instanceof GoldenBaselineCaptureError &&
    error.code === "BASELINE_CLOUD_CONSENT_REQUIRED"
  ) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`BASELINE_CAPTURE_FAILED: ${message}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let consent = false;
  let corpusPath: string | undefined;
  let live = false;
  let model: string | undefined;
  let outPath: string | undefined;
  let promptPath = DEFAULT_PROMPT_PATH;
  let replayPath: string | undefined;
  let trustPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--consent-cloud-transmission":
        consent = true;
        break;
      case "--corpus":
        corpusPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--live":
        live = true;
        break;
      case "--model":
        model = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--out":
        outPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--prompt":
        promptPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--replay":
        replayPath = requireValue(argv, index, argument);
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
  if (corpusPath === undefined) {
    throw new UsageError("--corpus is required");
  }
  if (live === (replayPath !== undefined)) {
    throw new UsageError("exactly one of --live or --replay is required");
  }
  if (live && model === undefined) {
    throw new UsageError("--model is required with --live");
  }
  return {
    consent,
    corpusPath,
    mode: live ? "live" : "replay",
    ...(model === undefined ? {} : { model }),
    ...(outPath === undefined ? {} : { outPath }),
    promptPath,
    ...(replayPath === undefined ? {} : { replayPath }),
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

/** CI must never reach a live provider, regardless of local flags. */
function assertLiveModePreconditions(parsed: ParsedArguments): void {
  if (parsed.mode !== "live") return;
  if (
    isTruthyEnvironment(process.env.CI) ||
    isTruthyEnvironment(process.env.GITHUB_ACTIONS)
  ) {
    throw new UsageError(
      "BASELINE_LIVE_CAPTURE_BLOCKED_IN_CI: live provider capture is forbidden in CI environments",
    );
  }
  if (!parsed.consent) {
    throw new UsageError(
      "BASELINE_CLOUD_CONSENT_REQUIRED: pass --consent-cloud-transmission to send the anonymized corpus to the provider",
    );
  }
}

function isTruthyEnvironment(value: string | undefined): boolean {
  return (
    value !== undefined && value !== "" && value !== "false" && value !== "0"
  );
}

async function buildProvider(
  parsed: ParsedArguments,
  corpus: unknown,
): Promise<{
  measuredAt: string;
  predictionProvider: BaselinePredictionProvider;
}> {
  if (parsed.mode === "live") {
    return {
      measuredAt: new Date().toISOString(),
      predictionProvider: createAdapterPredictionProvider(
        new AnthropicProviderAdapter(),
      ),
    };
  }
  const provider = createRecordedPredictionProvider(
    await readJson(parsed.replayPath!),
  );
  const corpusId = (corpus as { corpus_id?: unknown }).corpus_id;
  if (provider.recorded.corpus_id !== corpusId) {
    throw new GoldenBaselineCaptureError(
      "BASELINE_CORPUS_MISMATCH",
      "recorded predictions were captured for a different corpus",
    );
  }
  return {
    measuredAt: provider.recorded.recorded_at,
    predictionProvider: provider,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}
