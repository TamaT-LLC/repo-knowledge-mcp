import picomatch from "picomatch";

/**
 * picomatch options shared by every repository scope glob matcher.
 *
 * `noextglob` turns off extglob semantics (`+(..)`, `@(..)`, `!(..)`, `*(..)`,
 * `?(..)`): the prefix character keeps its plain glob meaning and no extglob
 * quantifier is applied to the parenthesized group.
 * Scope patterns can come from distilled review content, so extglobs are
 * never compiled: repeated extglobs are the pattern shape most prone to
 * catastrophic backtracking, and scopes have no use for them.
 */
export function scopeGlobOptions(): picomatch.PicomatchOptions {
  return { dot: true, nocase: false, noextglob: true };
}
