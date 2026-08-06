import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateGoldenFixture } from "./golden-evaluator.js";

const path = resolve(process.argv[2] ?? "test/fixtures/golden/m1-golden.json");

try {
  const input = JSON.parse(await readFile(path, "utf8")) as unknown;
  process.stdout.write(
    `${JSON.stringify(evaluateGoldenFixture(input), null, 2)}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GOLDEN_EVALUATION_FAILED: ${message}\n`);
  process.exitCode = 2;
}
