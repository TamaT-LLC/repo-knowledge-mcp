import { Minimatch } from "minimatch";

import { ScopePatternSchema } from "./domain-schemas.js";

function relativePattern(pattern: string): string {
  return ScopePatternSchema.parse(pattern).replace(/^\.\//u, "");
}

/** Scope paths are repo-relative POSIX paths, including hidden files. */
export function compileScopeGlob(pattern: string): (path: string) => boolean {
  const relative = relativePattern(pattern);
  const matcher = new Minimatch(relative, {
    dot: true,
    nocase: false,
    nocomment: true,
    noext: true,
    nonegate: true,
    optimizationLevel: 0,
    platform: "linux",
    preserveMultipleSlashes: true,
  });

  // A stored literal file name can itself contain glob punctuation. A
  // trailing globstar on a literal path also includes the path itself.
  return (path) =>
    relative === path || relative === `${path}/**` || matcher.match(path);
}

/** Only complete literal path components can prove two scopes disjoint. */
export function scopeGlobBase(pattern: string): string {
  const parts = relativePattern(pattern).split("/");
  // Stop before escapes, classes, braces or groups as well as wildcards.
  // This keeps ambiguous (including extglob-looking) pairs as candidates.
  const firstGlob = parts.findIndex((part) => /[*?[{(\\]/u.test(part));
  return parts
    .slice(0, firstGlob < 0 ? parts.length : firstGlob)
    .join("/")
    .replace(/\/$/u, "");
}
