import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config.mjs";

// The suite again, with every compileWhenHot schema compiled on first use and
// checked against the runtime parser. Suites whose work happens in a child
// process (the built CLI or MCP server) are left out: the setup only reaches
// this process, so running them again would test nothing new.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // mergeConfig appends these to the base config's excludes.
      exclude: [
        "test/mcp-stdio-e2e.test.ts",
        "test/readiness-mcp-e2e.test.ts",
        "test/record-outcome-mcp-e2e.test.ts",
        "test/review-cli-pty-e2e.test.ts",
        "test/setup-cli-pty-e2e.test.ts",
        "test/stats-cli-mcp-e2e.test.ts",
        "test/sync-cli-mcp-e2e.test.ts",
      ],
      setupFiles: ["./test/support/compile-every-hot-schema.ts"],
    },
  }),
);
