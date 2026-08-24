/* global URL */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { coverageConfig } from "../../../coverage.config.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    coverage: {
      ...coverageConfig,
      exclude: [],
      include: ["source.ts"],
      reporter: ["text-summary"],
    },
    include: ["test-fixture.ts"],
  },
});
