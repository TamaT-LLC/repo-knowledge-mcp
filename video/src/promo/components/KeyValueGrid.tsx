import type { CSSProperties, ReactNode } from "react";

import { useLayout } from "../context";
import { COLORS, STAGGER_FRAMES } from "../theme";
import { Reveal } from "./Reveal";
import { CODE_STYLE } from "./Text";

export type KeyValueRow = {
  readonly key: string;
  readonly value: ReactNode;
  /** Unique React key when two rows share the same `key` text. */
  readonly id?: string;
};

const COLUMN_GAP_EM = 0.9;
const ROW_GAP_EM = 0.45;

export type KeyValueGridProps = {
  rows: readonly KeyValueRow[];
  /** Scene-relative frame of the first row. */
  at: number;
  stagger?: number;
  exitAt?: number;
  size?: number;
  /** Muted symbol printed after each key. Pass "" for none. */
  separator?: string;
  /** Per-row emphasis (e.g. highlight the rule row). */
  rowStyle?: (row: KeyValueRow, index: number) => CSSProperties | undefined;
  style?: CSSProperties;
};

/** The key cell and value cell of one row (two grid items). */
function rowCells(
  row: KeyValueRow,
  start: number,
  { exitAt, separator }: { exitAt?: number; separator: string },
  extra: CSSProperties | undefined,
): ReactNode[] {
  const id = row.id ?? row.key;
  return [
    <Reveal key={`${id}-key`} at={start} exitAt={exitAt} style={extra}>
      <span style={{ color: COLORS.accent2 }}>{row.key}</span>
      {separator ? (
        <span style={{ color: COLORS.muted }}>{separator}</span>
      ) : null}
    </Reveal>,
    <Reveal
      key={`${id}-value`}
      at={start}
      exitAt={exitAt}
      style={{ color: COLORS.fg, ...extra }}
    >
      {row.value}
    </Reveal>,
  ];
}

/**
 * JSON-like key/value display. Never aligns with spaces: keys (accent2) and
 * values (fg) sit in a two-column grid; symbols are muted. Rows wipe in one
 * after another (3-frame stagger) starting at `at`.
 */
export function KeyValueGrid({
  rows,
  at,
  stagger = STAGGER_FRAMES,
  exitAt,
  size,
  separator = ":",
  rowStyle,
  style,
}: KeyValueGridProps): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        ...CODE_STYLE,
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        columnGap: `${COLUMN_GAP_EM}em`,
        rowGap: `${ROW_GAP_EM}em`,
        fontSize: size ?? layout.type.codeSmall,
        ...style,
      }}
    >
      {rows.flatMap((row, index) =>
        rowCells(
          row,
          at + index * stagger,
          { exitAt, separator },
          rowStyle?.(row, index),
        ),
      )}
    </div>
  );
}
