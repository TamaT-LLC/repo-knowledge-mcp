import { createRequire } from "node:module";

// src/ and the installed dist/ directory share the same package manifest.
const manifest = createRequire(import.meta.url)("../package.json") as {
  readonly version: string;
};

export const REPO_KNOWLEDGE_PACKAGE_VERSION = manifest.version;
