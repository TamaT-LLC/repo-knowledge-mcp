import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateGoldenFixture } from "./golden-evaluator.js";
import { evaluateOutcomeRankingFixture } from "./outcome-ranking-golden.js";

const path = resolve(process.argv[2] ?? "test/fixtures/golden/m1-golden.json");

try {
  const input = JSON.parse(await readFile(path, "utf8")) as unknown;
  const report = isOutcomeRankingFixture(input)
    ? evaluateOutcomeRankingFixture(input)
    : evaluateGoldenFixture(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GOLDEN_EVALUATION_FAILED: ${message}\n`);
  process.exitCode = 2;
}

function isOutcomeRankingFixture(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { fixture_kind?: unknown }).fixture_kind === "outcome_ranking"
  );
}
