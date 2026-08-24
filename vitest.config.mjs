import { configDefaults, defineConfig } from "vitest/config";

// Several suites shell out to real child processes (CLI, MCP stdio and PTY
// end-to-end flows, locale-matrix digest checks) or drive SQLite over a temp
// directory. On an idle machine the slowest of those that does not pin its own
// timeout lands around 3.4s; under ordinary CPU contention it stretches past
// 4.6s, leaving well under a second of headroom against Vitest's 5s default.
// The result is a timeout that reports a scheduling delay as a test failure.
//
// 30s keeps roughly a six-fold margin over the slowest measured run while
// staying in line with the 15s-120s timeouts these suites already pin
// individually, and it still surfaces a genuine hang quickly.
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
