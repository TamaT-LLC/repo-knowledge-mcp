/* global URL */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EXPECTED_PACKAGE_NAME,
  assertEquivalentManifests,
  findSecretPattern,
  parseRootDeclaration,
  validatePackagePath,
  validatePublicApiManifest,
  validateRootDeclaration,
  validateRootRuntimeExports,
} from "./package-artifact-gate.mjs";
import {
  EXPECTED_PACKAGE_EXPORTS,
  STABLE_ROOT_API,
  STABLE_ROOT_RUNTIME_EXPORTS,
} from "./public-api-inventory.mjs";
import { parseLockedTypeScriptVersion } from "./package-smoke.mjs";
import {
  BOOTSTRAP_INVENTORY_SCHEMA,
  BOOTSTRAP_TAG,
  BOOTSTRAP_VERSION,
  buildBootstrapPackage,
  createBootstrapManifest,
} from "./build-bootstrap-package.mjs";
import {
  parsePublishedVersion,
  validateRegistrySmokeRequest,
} from "./registry-smoke.mjs";
import {
  EXPECTED_REGISTRY,
  EXPECTED_REPOSITORY_URL,
  compareVersions,
  findReleaseLicenseFile,
  isPublishableLicense,
  isSupportedReleaseNode,
  validateReleaseMetadata,
} from "./release-gate.mjs";

test("package artifact paths use an explicit release allowlist", () => {
  for (const path of [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    "prompts/distill.md",
    "dist/bin.js",
    "dist/domain-schemas.d.ts",
    "dist/doctor/checks-canonical.js",
    "dist/doctor/checks-canonical.d.ts",
  ]) {
    assert.doesNotThrow(() => validatePackagePath(path));
  }

  for (const path of [
    ".npmrc",
    ".repo-knowledge/config.json",
    "dist/fixture.json",
    "dist/private.pem",
    "dist/doctor/nested/checks-canonical.js",
    "fixtures/review.json",
    "../package.json",
    "/tmp/package.json",
  ]) {
    assert.throws(() => validatePackagePath(path));
  }
});

test("package artifact scanning recognizes credential material", () => {
  assert.equal(
    findSecretPattern("-----BEGIN OPENSSH PRIVATE KEY-----"),
    "private_key",
  );
  assert.equal(
    findSecretPattern("//registry.npmjs.org/:_authToken=placeholder"),
    "npm_auth_token_config",
  );
  assert.equal(findSecretPattern(`token=npm_${"a".repeat(36)}`), "npm_token");
  assert.equal(
    findSecretPattern(`token=ghp_${"b".repeat(36)}`),
    "github_token",
  );
  assert.equal(
    findSecretPattern(`key=AKIA${"C".repeat(16)}`),
    "aws_access_key",
  );
  assert.equal(
    findSecretPattern(
      "Set ANTHROPIC_API_KEY only when provider mode is enabled.",
    ),
    null,
  );
});

test("stable root API matches the reviewed manifest and declaration inventory", () => {
  assert.doesNotThrow(() =>
    validatePublicApiManifest({
      exports: EXPECTED_PACKAGE_EXPORTS,
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    }),
  );
  const declaration = `/** Stable root. */
export { runDefaultRepoKnowledgeCli, type RunDefaultRepoKnowledgeCliOptions } from "./cli-runtime.js";
`;
  assert.deepEqual(
    parseRootDeclaration(declaration).sort(comparePublicApiEntries),
    [...STABLE_ROOT_API].sort(comparePublicApiEntries),
  );
  assert.doesNotThrow(() => validateRootDeclaration(declaration));
  assert.doesNotThrow(() =>
    validateRootRuntimeExports(STABLE_ROOT_RUNTIME_EXPORTS),
  );
});

test("public API gates reject accidental internal root exports", () => {
  const declaration = `
export { runDefaultRepoKnowledgeCli, type RunDefaultRepoKnowledgeCliOptions } from "./cli-runtime.js";
export { CanonicalTransactionStore } from "./canonical-transaction-store.js";
`;
  assert.throws(
    () => validateRootDeclaration(declaration),
    /CanonicalTransactionStore/u,
  );
  assert.throws(
    () =>
      validateRootRuntimeExports([
        ...STABLE_ROOT_RUNTIME_EXPORTS,
        "CanonicalTransactionStore",
      ]),
    /CanonicalTransactionStore/u,
  );
  assert.throws(() =>
    validatePublicApiManifest({
      exports: {
        ...EXPECTED_PACKAGE_EXPORTS,
        "./internal": "./dist/internal.js",
      },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    }),
  );
});

test("package smoke installs the exact locked TypeScript compiler", async () => {
  const packageLock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.equal(parseLockedTypeScriptVersion(packageLock), "6.0.3");
  assert.throws(
    () =>
      parseLockedTypeScriptVersion({
        packages: { "node_modules/typescript": { version: "^6.0.3" } },
      }),
    /exact TypeScript compiler version/u,
  );
  assert.throws(
    () => parseLockedTypeScriptVersion({ packages: {} }),
    /expected an object/u,
  );
});

test("bootstrap manifest is an inert scoped name reservation", () => {
  const manifest = createBootstrapManifest(EXPECTED_PACKAGE_NAME);
  assert.equal(manifest.name, EXPECTED_PACKAGE_NAME);
  assert.equal(manifest.version, BOOTSTRAP_VERSION);
  assert.deepEqual(manifest.files, ["LICENSE", "README.md"]);
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: EXPECTED_REGISTRY,
    tag: BOOTSTRAP_TAG,
  });
  assert.equal(
    manifest.repository.url,
    "git+https://github.com/TamaT-LLC/repo-knowledge-mcp.git",
  );
  for (const forbidden of [
    "private",
    "bin",
    "scripts",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    assert.equal(manifest[forbidden], undefined);
  }
  assert.throws(() => createBootstrapManifest("lookalike-package"));
});

test("bootstrap builder emits one reviewed tarball and inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rkm-bootstrap-package-"));
  const output = join(root, "npm-bootstrap");
  try {
    const inventory = await buildBootstrapPackage({ output });
    assert.equal(inventory.schema_version, BOOTSTRAP_INVENTORY_SCHEMA);
    assert.equal(inventory.package.name, EXPECTED_PACKAGE_NAME);
    assert.equal(inventory.package.version, BOOTSTRAP_VERSION);
    assert.equal(inventory.package.file_count, 3);
    assert.match(inventory.package.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      (await readdir(output)).sort(),
      [inventory.package.tarball, "npm-bootstrap-package.json"].sort(),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(output, "npm-bootstrap-package.json"), "utf8"),
      ),
      inventory,
    );
    await assert.rejects(() => buildBootstrapPackage({ output }), /exists/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release workflow publishes stable packages with OIDC only", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /id-token: write/u);
  assert.match(
    workflow,
    /@tamat-llc\/repo-knowledge-mcp@0\.0\.0-bootstrap\.0/u,
  );
  assert.match(workflow, /--tag latest/u);
  assert.match(workflow, /--provenance/u);
  assert.doesNotMatch(workflow, /secrets\.(?:NPM|NODE_AUTH_TOKEN)/u);
  assert.doesNotMatch(workflow, /bootstrap-auth-gate/u);
});

test("dry-run and packed manifests must describe the same artifact", () => {
  const base = {
    files: [{ mode: 420, path: "package.json", size: 100 }],
    integrity: "sha512-example",
    name: EXPECTED_PACKAGE_NAME,
    shasum: "abc123",
    version: "0.3.0",
  };
  assert.doesNotThrow(() => assertEquivalentManifests(base, { ...base }));
  assert.throws(
    () =>
      assertEquivalentManifests(base, {
        ...base,
        files: [...base.files, { mode: 420, path: ".npmrc", size: 10 }],
      }),
    /file manifests differ/u,
  );
});

test("release metadata accepts one clean unpublished main commit", () => {
  const input = validReleaseInput();
  assert.deepEqual(validateReleaseMetadata(input), {
    commit: input.expectedCommit,
    failures: [],
    license: "MIT",
    license_file: "LICENSE",
    name: EXPECTED_PACKAGE_NAME,
    node_version: "v24.0.0",
    npm_version: "11.5.1",
    registry_status: "available",
    report_kind: "repo_knowledge_npm_release_gate",
    repository_visibility: "public",
    schema_version: 2,
    status: "pass",
    tag: "v0.3.0",
    version: "0.3.0",
  });
});

test("release metadata rejects mutable or inconsistent release state", () => {
  const input = validReleaseInput();
  const report = validateReleaseMetadata({
    ...input,
    headCommit: "b".repeat(40),
    mainContainsCommit: false,
    npmVersion: "11.5.0",
    nodeVersion: "v22.13.1",
    packageDocument: {
      ...input.packageDocument,
      license: "UNLICENSED",
      publishConfig: {
        access: "restricted",
        provenance: false,
        registry: "https://example.test/",
      },
    },
    licenseFile: null,
    registryVersion: "0.3.0",
    repositoryVisibility: "private",
    tag: "v0.3.1",
    worktreeClean: false,
  });
  assert.equal(report.status, "fail");
  assert.deepEqual(report.failures, [
    "release tag must be v0.3.0",
    "HEAD does not match the release commit",
    "release commit is not reachable from origin/main",
    "release worktree is not clean",
    "package.json license must be an explicit publishable license value",
    "release commit must contain a non-empty regular LICENSE or LICENSE.md file",
    "repository must be public for npm provenance",
    "publishConfig.access must be public",
    "publishConfig.provenance must be true",
    `publishConfig.registry must be ${EXPECTED_REGISTRY}`,
    "release Node must be 22.14.0+ or 24+",
    "trusted publishing requires npm 11.5.1+",
    `${EXPECTED_PACKAGE_NAME}@0.3.0 is already present in the registry`,
  ]);
});

test("release metadata requires explicit license metadata and a real license file", async () => {
  assert.equal(isPublishableLicense("MIT"), true);
  assert.equal(isPublishableLicense("Apache-2.0 OR MIT"), true);
  assert.equal(isPublishableLicense("UNLICENSED"), false);
  assert.equal(isPublishableLicense(" MIT "), false);
  assert.equal(isPublishableLicense(undefined), false);

  const root = await mkdtemp(join(tmpdir(), "rkm-release-license-"));
  try {
    assert.equal(await findReleaseLicenseFile(root), null);
    await writeFile(join(root, "LICENSE"), "");
    assert.equal(await findReleaseLicenseFile(root), null);
    await writeFile(join(root, "LICENSE"), "MIT License\n");
    assert.equal(await findReleaseLicenseFile(root), "LICENSE");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release runtime version checks match the documented floor", () => {
  assert.equal(isSupportedReleaseNode("v22.14.0"), true);
  assert.equal(isSupportedReleaseNode("22.13.9"), false);
  assert.equal(isSupportedReleaseNode("24.0.0"), true);
  assert.equal(isSupportedReleaseNode("23.9.0"), false);
  assert.equal(compareVersions("11.5.1", "11.5.1"), 0);
  assert.ok(compareVersions("11.6.0", "11.5.1") > 0);
  assert.ok(Number.isNaN(compareVersions("latest", "11.5.1")));
});

test("registry smoke requires the fixed package and an exact stable version", () => {
  const request = {
    attempts: 3,
    name: EXPECTED_PACKAGE_NAME,
    version: "0.3.0",
  };
  assert.equal(validateRegistrySmokeRequest(request), request);
  assert.equal(parsePublishedVersion('"0.3.0"'), "0.3.0");
  assert.throws(() =>
    validateRegistrySmokeRequest({ ...request, name: "lookalike-package" }),
  );
  assert.throws(() =>
    validateRegistrySmokeRequest({ ...request, version: "latest" }),
  );
  assert.throws(() =>
    validateRegistrySmokeRequest({ ...request, attempts: 0 }),
  );
  assert.throws(() =>
    validateRegistrySmokeRequest({ ...request, attempts: 61 }),
  );
  assert.throws(() => parsePublishedVersion('["0.3.0"]'));
});

function validReleaseInput() {
  const commit = "a".repeat(40);
  return {
    expectedCommit: commit,
    headCommit: commit,
    licenseFile: "LICENSE",
    mainContainsCommit: true,
    nodeVersion: "v24.0.0",
    npmVersion: "11.5.1",
    packageDocument: {
      license: "MIT",
      name: EXPECTED_PACKAGE_NAME,
      publishConfig: {
        access: "public",
        provenance: true,
        registry: EXPECTED_REGISTRY,
      },
      repository: { type: "git", url: EXPECTED_REPOSITORY_URL },
      version: "0.3.0",
    },
    registryVersion: null,
    repositoryVisibility: "public",
    tag: "v0.3.0",
    tagCommit: commit,
    worktreeClean: true,
  };
}

function comparePublicApiEntries(left, right) {
  return `${left.kind}:${left.name}:${left.source}`.localeCompare(
    `${right.kind}:${right.name}:${right.source}`,
  );
}
