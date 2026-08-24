export const EXPECTED_PACKAGE_EXPORTS = Object.freeze({
  ".": Object.freeze({
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  }),
  "./experimental": Object.freeze({
    types: "./dist/experimental.d.ts",
    import: "./dist/experimental.js",
  }),
  "./package.json": "./package.json",
});

export const STABLE_ROOT_API = Object.freeze([
  Object.freeze({
    kind: "type",
    name: "RunDefaultRepoKnowledgeCliOptions",
    source: "./cli-runtime.js",
  }),
  Object.freeze({
    kind: "value",
    name: "runDefaultRepoKnowledgeCli",
    source: "./cli-runtime.js",
  }),
]);

export const STABLE_ROOT_RUNTIME_EXPORTS = Object.freeze(
  STABLE_ROOT_API.filter(({ kind }) => kind === "value").map(
    ({ name }) => name,
  ),
);
