// Vitest config for scripts/benchmark-zod-compile.mjs; see that file.
import { defineConfig, mergeConfig } from "vitest/config";

import base from "../vitest.config.mjs";
import compiled from "../vitest.compiled.config.mjs";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // The same suites as `npm run test:compiled`; child-process suites never
      // reach this process's schemas.
      exclude: compiled.test.exclude,
      // One file at a time, so measurements do not compete for the CPU.
      fileParallelism: false,
      setupFiles: ["./scripts/benchmark-zod-compile.setup.mjs"],
    },
  }),
);
