import {
  GeneratedCodeExampleSchema,
  type GeneratedCodeExample,
} from "./domain-schemas.js";

/**
 * Canonical Markdown representation of an M2 generated code example
 * (design doc Architecture §6.2 and §12).
 *
 * The example lives at the end of the knowledge body as one HTML-comment
 * marker followed by one fenced code block:
 *
 *   <!-- generated_example: true; evidence_comment_ids: PRRC_a, PRRC_b -->
 *
 *   ```typescript
 *   const result = await invoke();
 *   ```
 *
 * Migration policy: the knowledge frontmatter stays at `schema_version: 1`.
 * M1 documents simply have no marker, so `parseKnowledgeBodyCodeExample`
 * returns `code_example: null` for them and no migration is required.
 * Parsing is fail-soft because humans may edit the Markdown directly: a
 * marker whose section no longer forms a valid example yields `null` while
 * the full body is preserved as `detail`.
 */

export const KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX =
  "<!-- generated_example: true; evidence_comment_ids: ";

export const MINIMUM_CODE_EXAMPLE_FENCE_LENGTH = 3;

const MARKER_PATTERN =
  /^<!-- generated_example: true; evidence_comment_ids: (?<ids>[^\n]+?) -->$/gmu;
const FENCE_OPEN_PATTERN = /^\n+(?<fence>`{3,})(?<language>[^\n]*)\n/u;
const TERMINAL_FENCE_PATTERN = /(?:^|\n)(?<fence>`{3,})$/u;

export interface ParsedKnowledgeBody {
  readonly code_example: GeneratedCodeExample | null;
  readonly detail: string;
}

/** Renders the marker plus fenced block for one grounded code example. */
export function renderKnowledgeCodeExampleSection(
  example: GeneratedCodeExample,
): string {
  const parsed = GeneratedCodeExampleSchema.parse(example);
  const fence = "`".repeat(
    Math.max(
      MINIMUM_CODE_EXAMPLE_FENCE_LENGTH,
      longestBacktickRun(parsed.content) + 1,
    ),
  );
  return [
    `${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}${parsed.evidence_comment_ids.join(
      ", ",
    )} -->`,
    "",
    `${fence}${parsed.language}`,
    parsed.content.replace(/\n+$/u, ""),
    fence,
  ].join("\n");
}

/** Appends the canonical example section to a detail body when present. */
export function renderKnowledgeBodyWithCodeExample(
  detail: string,
  example?: GeneratedCodeExample,
): string {
  if (example === undefined) return detail;
  return [
    detail.trimEnd(),
    "",
    renderKnowledgeCodeExampleSection(example),
  ].join("\n");
}

/**
 * Splits a canonical knowledge body into its detail and structured example.
 * Bodies without a marker (every M1 document) parse to `code_example: null`
 * with the body untouched; malformed or hand-edited sections fail soft the
 * same way so the read path never rejects a canonical document.
 */
export function parseKnowledgeBodyCodeExample(
  body: string,
): ParsedKnowledgeBody {
  const withoutExample: ParsedKnowledgeBody = {
    code_example: null,
    detail: body,
  };
  let marker: RegExpExecArray | null = null;
  for (const candidate of body.matchAll(MARKER_PATTERN)) marker = candidate;
  if (marker === null) return withoutExample;

  const section = body.slice(marker.index + marker[0].length);
  const open = FENCE_OPEN_PATTERN.exec(section);
  if (open === null) return withoutExample;
  const fence = open.groups!.fence!;
  const afterOpen = section.slice(open[0].length).replace(/\s+$/u, "");
  const terminal = TERMINAL_FENCE_PATTERN.exec(afterOpen);
  if (terminal === null || terminal.groups!.fence !== fence) {
    return withoutExample;
  }

  const parsed = GeneratedCodeExampleSchema.safeParse({
    content: afterOpen.slice(0, terminal.index),
    evidence_comment_ids: marker
      .groups!.ids!.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    generated_example: true,
    language: open.groups!.language!,
  });
  if (!parsed.success) return withoutExample;
  return {
    code_example: parsed.data,
    detail: body.slice(0, marker.index).trimEnd(),
  };
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const run of value.matchAll(/`+/gu)) {
    longest = Math.max(longest, run[0].length);
  }
  return longest;
}
