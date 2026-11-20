import { Minimatch } from "minimatch";

import { ScopePatternSchema } from "./domain-schemas.js";

function relativePattern(pattern: string): string {
  return ScopePatternSchema.parse(pattern).replace(/^\.\//u, "");
}

/** Older stored scopes match a simple class such as [id] both ways. */
function withBracketAlternatives(pattern: string): string {
  if (!pattern.includes("[")) return pattern;

  // Quote user-supplied group syntax before introducing our own alternatives.
  const quoted = pattern.replace(/\\[\s\S]|[()|]/gu, (token) =>
    token.startsWith("\\") ? token : `\\${token}`,
  );
  // Consume escapes and whole classes, including POSIX classes like [[:digit:]].
  const rewritten = quoted.replace(
    /\\[\s\S]|\[(?:\\[\s\S]|\[:[a-z]+:\]|[^\]\\/])+\]/gu,
    (token) => {
      if (!token.startsWith("[")) return token;
      const members = token.slice(1, -1);
      // A leading ! is a literal member, including in ranges like [!0-9].
      const charClass = token.replace(/^\[!/u, "[\\!");
      // Ranges and other class expressions only match a character.
      if (/[-*+?.^${}()|[\]\\]/u.test(members)) return charClass;
      // A local choice avoids brace-expanding every combination of classes.
      return `@(\\[${members}\\]|${charClass})`.replaceAll(",", "\\,");
    },
  );
  return rewritten === quoted ? pattern : rewritten;
}

/** Scope paths are repo-relative POSIX paths, including hidden files. */
export function compileScopeGlob(pattern: string): (path: string) => boolean {
  const relative = relativePattern(pattern);
  const matchPattern = withBracketAlternatives(relative);
  const matcher = new Minimatch(matchPattern, {
    dot: true,
    nocase: false,
    nocomment: true,
    noext: matchPattern === relative,
    nonegate: true,
    optimizationLevel: 0,
    platform: "linux",
    preserveMultipleSlashes: true,
  });

  // A trailing globstar includes its parent (src/{api,cli}/** includes
  // src/api). When the parent ends in an unescaped star, the slash is
  // required: src/a*/** covers descendants of src/api.
  const parent = relative.replace(/(?:\/\*\*)+$/u, "");
  const includesParent =
    parent !== relative && !/(?<!\\)(?:\\\\)*\*$/u.test(parent);

  return (path) =>
    relative === path ||
    matcher.match(path) ||
    (includesParent && matcher.match(`${path}/`));
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
