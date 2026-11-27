/**
 * Case folding for matching (paths, dictionary terms). JavaScript has no
 * Unicode case fold, so this approximates the full folding (CaseFolding.txt
 * C + F): upper-casing applies the multi-character mappings (`ß` -> `SS`,
 * `ŉ` -> `ʼN`), lower-casing brings them back down, and final sigma is
 * folded to `σ`. Where it differs from the full folding it can only make
 * more strings equal, the safe side for masking and deletion.
 */
export function foldCase(value: string): string {
  return value.toUpperCase().toLowerCase().replaceAll("ς", "σ");
}
