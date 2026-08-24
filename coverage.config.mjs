export const coverageThresholds = {
  branches: 73,
  functions: 91,
  lines: 84,
  statements: 83,
};

export const coverageConfig = {
  exclude: ["src/**/*.d.ts"],
  include: ["src/**/*.ts"],
  provider: "v8",
  reporter: ["text", "json-summary"],
  thresholds: coverageThresholds,
};
