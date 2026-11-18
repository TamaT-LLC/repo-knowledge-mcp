import { Minimatch } from "minimatch";

const SCOPE_GLOB_OPTIONS = { dot: true, nocase: false } as const;
const GLOB_SEGMENT = /[*?[\]{}()!]/u;

/** Compiles a scope glob; a leading `./` is ignored like a repository path. */
export function compileScopeGlob(pattern: string): (path: string) => boolean {
  const matcher = new Minimatch(
    stripCurrentDirectory(pattern),
    SCOPE_GLOB_OPTIONS,
  );
  return (path) => matcher.match(path);
}

export interface ScopeGlobScan {
  readonly base: string;
  readonly isGlob: boolean;
}

/** Returns whether the pattern has glob syntax and its literal leading path. */
export function scanScopeGlob(pattern: string): ScopeGlobScan {
  const path = stripCurrentDirectory(pattern.replace(/^!/u, ""));
  const isGlob = new Minimatch(path, SCOPE_GLOB_OPTIONS).hasMagic();
  if (!isGlob) return { base: path, isGlob };
  const base: string[] = [];
  for (const segment of path.split("/")) {
    if (GLOB_SEGMENT.test(segment)) break;
    base.push(segment);
  }
  return { base: base.join("/"), isGlob };
}

function stripCurrentDirectory(pattern: string): string {
  return pattern.replace(/^\.\//u, "");
}
