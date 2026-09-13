export const coverageThresholds = {
  branches: 73,
  functions: 91,
  lines: 84,
  statements: 83,
};

// Exact paths keep a regression in one command or state transition from being
// hidden by better coverage elsewhere. CLI launchers remain in global coverage.
export const coverageFileThresholds = {
  "src/cli-args.ts": {
    branches: 90,
    functions: 100,
    lines: 94,
    statements: 94,
  },
  "src/cli.ts": { branches: 95, functions: 100, lines: 100, statements: 100 },
  "src/setup-service.ts": {
    branches: 80,
    functions: 95,
    lines: 95,
    statements: 93,
  },
  "src/distill-job-state.ts": {
    branches: 85,
    functions: 100,
    lines: 90,
    statements: 90,
  },
  "src/golden-baseline-command.ts": {
    branches: 90,
    functions: 100,
    lines: 95,
    statements: 95,
  },
  "src/golden-command.ts": {
    branches: 90,
    functions: 100,
    lines: 100,
    statements: 100,
  },
  "src/pilot-daily-record-command.ts": {
    branches: 75,
    functions: 100,
    lines: 90,
    statements: 88,
  },
  "src/quality-gate-command.ts": {
    branches: 90,
    functions: 100,
    lines: 100,
    statements: 100,
  },
};

export const coverageConfig = {
  exclude: ["src/**/*.d.ts"],
  include: ["src/**/*.ts"],
  provider: "v8",
  reporter: ["text", "json", "json-summary"],
  thresholds: { ...coverageThresholds, ...coverageFileThresholds },
};
