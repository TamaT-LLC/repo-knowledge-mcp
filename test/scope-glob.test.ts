import { describe, expect, it } from "vitest";

import { compileScopeGlob, scanScopeGlob } from "../src/scope-glob.js";

describe("scope glob", () => {
  it.each([
    ["src/**/*.ts", "src/a/b.ts", true],
    ["**/*.yml", ".github/workflows/ci.yml", true],
    ["src/{a,b}/*.ts", "src/b/x.ts", true],
    ["./src/**", "src/index.ts", true],
    ["README.md", "README.md", true],
    ["docs/*", "docs/a/b.md", false],
    ["SRC/**", "src/index.ts", false],
  ])("matches %s against %s as %s", (pattern, path, expected) => {
    expect(compileScopeGlob(pattern)(path)).toBe(expected);
  });

  it.each([
    ["src/**/*.ts", { base: "src", isGlob: true }],
    ["./src/admin/**", { base: "src/admin", isGlob: true }],
    ["src/{a,b}/*.ts", { base: "src", isGlob: true }],
    ["**/*.ts", { base: "", isGlob: true }],
    ["src/setup-service.ts", { base: "src/setup-service.ts", isGlob: false }],
  ])("scans %s", (pattern, expected) => {
    expect(scanScopeGlob(pattern)).toEqual(expected);
  });
});
