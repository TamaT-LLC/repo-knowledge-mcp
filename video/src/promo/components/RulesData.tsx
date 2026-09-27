import type { CSSProperties, ReactNode } from "react";

import type { Point } from "../layout";
import { HERO_COMMENT_HEAD, HERO_RULE } from "../story";
import { COLORS, LINE_HEIGHT } from "../theme";
import { KeyValueGrid, type KeyValueRow } from "./KeyValueGrid";
import { Reveal } from "./Reveal";
import { CODE_STYLE, Sym } from "./Text";

// The simplified get_rules call and response of s06 (README "レビューが rule
// になるまで", simplified). The grid geometry is fixed here (key column,
// gaps) so the hero token can dock exactly on the rule's first words.

const COLUMN_GAP_EM = 0.9;
const ROW_GAP_EM = 0.45;
/** The rule wraps before these words: "…永続化する前に / strict schema…". */
const RULE_BREAK_BEFORE = "strict schema";

export type DataGridSpec = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Fixed width of the key column (keys + ":"). */
  readonly keyColumn: number;
  /** Total width of the grid. */
  readonly width: number;
};

export const REQUEST_ROWS: readonly KeyValueRow[] = [
  { key: "file_paths", value: "src/github/client.ts" },
  { key: "task", value: "API 応答の保存処理を変更" },
];

/** Index of the rule row in responseRows(). */
export const RULE_ROW_INDEX = 1;
/** Line count of each response row (the rule wraps to two lines). */
const RESPONSE_ROW_LINES = [1, 2, 1, 1, 1] as const;

export function responseRows(ruleValue: ReactNode): readonly KeyValueRow[] {
  return [
    { key: "readiness.state", value: "ready" },
    { key: "rule", value: ruleValue },
    { key: "severity", value: "should" },
    {
      key: "match",
      value: (
        <>
          {"src/github/**/*.ts "}
          <Sym>(scope)</Sym>
        </>
      ),
    },
    { key: "evidence_count", value: "2" },
  ];
}

const lineHeightPx = (size: number): number => size * LINE_HEIGHT.code;

/** Centre line of a code line of `size` whose box starts at `top`. */
export function codeLineCenter(top: number, size: number): number {
  return top + lineHeightPx(size) / 2;
}
const rowGapPx = (size: number): number => size * ROW_GAP_EM;

/** Height of a grid whose rows span `lines` text lines each. */
export function gridHeight(
  spec: DataGridSpec,
  lines: readonly number[],
): number {
  const text = lines.reduce((sum, n) => sum + n, 0) * lineHeightPx(spec.size);
  return text + Math.max(0, lines.length - 1) * rowGapPx(spec.size);
}

export function responseHeight(spec: DataGridSpec): number {
  return gridHeight(spec, RESPONSE_ROW_LINES);
}

export function requestHeight(spec: DataGridSpec): number {
  return gridHeight(
    spec,
    REQUEST_ROWS.map(() => 1),
  );
}

/** Station-space point where the rule value's text starts (centre line). */
export function ruleTextAnchor(spec: DataGridSpec): Point {
  const above = gridHeight(spec, RESPONSE_ROW_LINES.slice(0, RULE_ROW_INDEX));
  return {
    x: spec.x + spec.keyColumn + spec.size * COLUMN_GAP_EM,
    y: spec.y + above + rowGapPx(spec.size) + lineHeightPx(spec.size) / 2,
  };
}

/** HERO_RULE split into its two display lines ("…前に" / "strict schema…"). */
export function ruleLines(): readonly [string, string] {
  const breakAt = HERO_RULE.indexOf(RULE_BREAK_BEFORE);
  return [HERO_RULE.slice(0, breakAt).trimEnd(), HERO_RULE.slice(breakAt)];
}

/**
 * The rule text. Its head (the hero token's words) is `headStyle`-able so it
 * can wait as an empty slot until the token docks on it. Letter spacing is
 * normal so the glyphs line up with the token pill exactly.
 */
export function RuleValue({
  headStyle,
}: {
  headStyle?: CSSProperties;
}): ReactNode {
  const [first, second] = ruleLines();
  return (
    <span style={{ letterSpacing: "normal" }}>
      <span style={headStyle}>{HERO_COMMENT_HEAD}</span>
      {first.slice(HERO_COMMENT_HEAD.length)}
      <br />
      {second}
    </span>
  );
}

/** KeyValueGrid with the fixed geometry of `spec`. */
export function DataGrid({
  spec,
  rows,
  at,
  exitAt,
}: {
  spec: DataGridSpec;
  rows: readonly KeyValueRow[];
  at: number;
  exitAt?: number;
}): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        left: spec.x,
        top: spec.y,
        width: spec.width,
      }}
    >
      <KeyValueGrid
        rows={rows}
        at={at}
        exitAt={exitAt}
        size={spec.size}
        style={{
          gridTemplateColumns: `${spec.keyColumn}px minmax(0, 1fr)`,
          columnGap: spec.size * COLUMN_GAP_EM,
          rowGap: rowGapPx(spec.size),
        }}
      />
    </div>
  );
}

/** One code line (its own element, never space-aligned). */
export function CodeLine({
  x,
  y,
  size,
  at,
  exitAt,
  color = COLORS.fg,
  children,
}: {
  x: number;
  y: number;
  size: number;
  at: number;
  exitAt?: number;
  color?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div style={{ position: "absolute", left: x, top: y }}>
      <Reveal
        at={at}
        exitAt={exitAt}
        style={{
          ...CODE_STYLE,
          fontSize: size,
          color,
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </Reveal>
    </div>
  );
}
