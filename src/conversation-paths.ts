import { posix } from "node:path";

import { z } from "zod";

/**
 * The single normalization used both when a project path is HMACed for
 * storage and when a purge filter or `excludeProjects` path is matched, so the
 * two sides can never drift. It is lexical (no realpath): the directory may no
 * longer exist when a user purges it. Unicode is NFC so macOS NFD file names
 * match the same path typed on the command line.
 */
function normalizeProjectPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new TypeError("project path must be absolute");
  }
  if (path.includes("\0")) {
    throw new TypeError("project path must not contain NUL");
  }
  const normalized = posix.normalize(path.normalize("NFC"));
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

/**
 * The form a path is matched in: normalized, then case-folded. macOS file
 * systems are case-insensitive by default, so `/Users/bob/Work` and a purge
 * typed as `/users/bob/work` must match. On a case-sensitive system this can
 * only make a purge or exclusion cover more, the safe side for deletion.
 * Display paths keep their case; only matching and HMACs use this form.
 */
export function projectPathMatchKey(path: string): string {
  return normalizeProjectPath(path).toLowerCase();
}

/**
 * Every component-wise prefix of a path's match key, root first:
 * `/a/b` yields `/`, `/a`, `/a/b`. There is no depth cap, so a filter on a
 * deep path can never miss.
 */
export function projectPathPrefixes(path: string): string[] {
  const normalized = projectPathMatchKey(path);
  const prefixes = ["/"];
  let current = "";
  for (const component of normalized.split("/").slice(1)) {
    if (component.length === 0) continue;
    current += `/${component}`;
    prefixes.push(current);
  }
  return prefixes;
}

/** An absolute project path, normalized with `normalizeProjectPath`. */
export const ProjectPathSchema = z.string().transform((value, context) => {
  try {
    return normalizeProjectPath(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid project path",
    });
    return z.NEVER;
  }
});
