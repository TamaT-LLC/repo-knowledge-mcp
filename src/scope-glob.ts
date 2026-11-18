import picomatch from "picomatch";

/**
 * picomatch options shared by every repository scope glob matcher.
 *
 * `noextglob` turns off extglob semantics (`+(..)`, `@(..)`, `!(..)`, `*(..)`,
 * `?(..)`): the prefix character keeps its plain glob meaning and no extglob
 * quantifier is applied to the parenthesized group.
 * picomatch <= 4.0.7 has a ReDoS in repeated extglobs (GHSA-fc5q-39xc-vjpf)
 * with no fixed release, and scope patterns can come from distilled review
 * content, so extglobs are never compiled.
 */
export function scopeGlobOptions(): picomatch.PicomatchOptions {
  return { dot: true, nocase: false, noextglob: true };
}

/**
 * `picomatch.scan` only reads the `noext` alias. Scans use it so that the
 * glob base they report agrees with the matcher's extglob handling above.
 */
export function scopeGlobScanOptions(): NonNullable<
  Parameters<typeof picomatch.scan>[1]
> {
  return { noext: true };
}
