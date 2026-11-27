/**
 * Case folding for matching (paths, dictionary terms). JavaScript has no
 * Unicode case fold, so this approximates the full folding (CaseFolding.txt
 * C + F): upper-casing applies the multi-character mappings (`ß` -> `SS`,
 * `ŉ` -> `ʼN`), lower-casing brings them back down, and final sigma is
 * folded to `σ`. It is not the full folding (Turkish dotted I, for one,
 * differs), but it is idempotent and used on both sides of every match.
 */
export function foldCase(value: string): string {
  // Repeated until stable, so folding a folded value changes nothing:
  // `ẞ` lowers to `ß`, which only a second pass expands to `ss`.
  // Two passes settle every mapping in Unicode; the cap only guards a
  // future mapping that would not.
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current.toUpperCase().toLowerCase().replaceAll("ς", "σ");
    if (next === current) break;
    current = next;
  }
  return current;
}
