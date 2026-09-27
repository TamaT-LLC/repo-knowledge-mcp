import type { CSSProperties, ReactNode } from "react";

import {
  COLORS,
  FONT_FAMILY,
  FONT_WEIGHT,
  LINE_HEIGHT,
  SURFACE_COLORS,
} from "../theme";
import type { ReviewCardGeometry } from "./ReviewCard";
import { CODE_STYLE, Label } from "./Text";

// The pieces of the review card: file header, diff preview (abstract code
// bars, not real code) and the reviewer row (a generic silhouette).

export const REVIEW_FILE_DIR = "src/github/";
export const REVIEW_FILE_NAME = "client.ts";
const REVIEWER = "reviewer";
const REVIEW_VERB = "commented";
const ADDED_MARK = "+";

type DiffRow = {
  readonly number: number;
  /** Leading indent and bar widths, in em of the meta text size. */
  readonly indent: number;
  readonly bars: readonly number[];
};

const DIFF_ROWS: readonly DiffRow[] = [
  { number: 40, indent: 1, bars: [3.5, 8, 5] },
  { number: 41, indent: 1, bars: [5.5, 11] },
  { number: 42, indent: 2, bars: [3, 7.5, 12, 3.5] },
];

const BAR_HEIGHT_RATIO = 0.34;
const BAR_GAP_EM = 0.5;
const LINE_NUMBER_COLUMN_EM = 2.2;
const MARK_COLUMN_EM = 1.4;
const HOT_EDGE_PX = 3;
const GLYPH_WIDTH_EM = 0.62;
const GLYPH_HEIGHT_EM = 0.82;
const GLYPH_STROKE_PX = 1.5;
const GLYPH_RADIUS_PX = 2;
const GLYPH_GAP_EM = 0.6;
const AVATAR_HEAD_RATIO = 0.34;
const AVATAR_HEAD_TOP_RATIO = 0.2;
const AVATAR_BODY_RATIO = 0.66;
const AVATAR_BODY_TOP_RATIO = 0.62;
const AUTHOR_GAP_EM = 0.6;
const VERB_GAP_EM = 0.4;

function FileGlyph(): ReactNode {
  return (
    <span
      style={{
        display: "inline-block",
        width: `${GLYPH_WIDTH_EM}em`,
        height: `${GLYPH_HEIGHT_EM}em`,
        marginRight: `${GLYPH_GAP_EM}em`,
        border: `${GLYPH_STROKE_PX}px solid ${SURFACE_COLORS.textSecondary}`,
        borderRadius: GLYPH_RADIUS_PX,
        verticalAlign: "-0.1em",
      }}
    />
  );
}

export function Header({
  geometry,
  eyebrow,
}: {
  geometry: ReviewCardGeometry;
  eyebrow: string;
}): ReactNode {
  return (
    <div
      style={{
        height: geometry.headerHeight,
        padding: `0 ${geometry.padX}px`,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: SURFACE_COLORS.cardHeader,
        borderBottom: `1px solid ${COLORS.hairline}`,
      }}
    >
      <span
        style={{
          ...CODE_STYLE,
          fontSize: geometry.metaSize,
          color: COLORS.fg,
          whiteSpace: "nowrap",
        }}
      >
        <FileGlyph />
        <span style={{ color: SURFACE_COLORS.textSecondary }}>
          {REVIEW_FILE_DIR}
        </span>
        {REVIEW_FILE_NAME}
      </span>
      <Label color={SURFACE_COLORS.textSecondary}>{eyebrow}</Label>
    </div>
  );
}

function DiffLine({
  row,
  isHot,
  geometry,
}: {
  row: DiffRow;
  isHot: boolean;
  geometry: ReviewCardGeometry;
}): ReactNode {
  const barHeight = geometry.rowHeight * BAR_HEIGHT_RATIO;
  const hot: CSSProperties = isHot
    ? {
        background: SURFACE_COLORS.lineHighlight,
        boxShadow: `inset ${HOT_EDGE_PX}px 0 0 ${COLORS.accent2}`,
      }
    : {};
  return (
    <div
      style={{
        height: geometry.rowHeight,
        display: "flex",
        alignItems: "center",
        padding: `0 ${geometry.padX}px`,
        fontSize: geometry.metaSize,
        ...hot,
      }}
    >
      <span
        style={{
          ...CODE_STYLE,
          width: `${LINE_NUMBER_COLUMN_EM}em`,
          color: SURFACE_COLORS.textSubtle,
        }}
      >
        {row.number}
      </span>
      <span
        style={{
          ...CODE_STYLE,
          width: `${MARK_COLUMN_EM}em`,
          color: COLORS.accent2,
        }}
      >
        {isHot ? ADDED_MARK : ""}
      </span>
      <div
        style={{
          flex: 1,
          display: "flex",
          gap: `${BAR_GAP_EM}em`,
          paddingLeft: `${row.indent}em`,
        }}
      >
        {row.bars.map((bar, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static decoration
            key={i}
            style={{
              width: `${bar}em`,
              flexShrink: 0,
              height: barHeight,
              borderRadius: barHeight / 2,
              background: isHot
                ? SURFACE_COLORS.skeletonHot
                : SURFACE_COLORS.skeleton,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function Diff({
  geometry,
}: {
  geometry: ReviewCardGeometry;
}): ReactNode {
  const rows = DIFF_ROWS.slice(-geometry.rows);
  const hotIndex = rows.length - 1;
  return (
    <div style={{ padding: `${geometry.diffPadY}px 0` }}>
      {rows.map((row, i) => (
        <DiffLine
          key={row.number}
          row={row}
          isHot={i === hotIndex}
          geometry={geometry}
        />
      ))}
    </div>
  );
}

function Avatar({ size }: { size: number }): ReactNode {
  const head = size * AVATAR_HEAD_RATIO;
  const body = size * AVATAR_BODY_RATIO;
  const part = {
    position: "absolute",
    borderRadius: "50%",
    background: SURFACE_COLORS.textSubtle,
  } as const;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        overflow: "hidden",
        background: SURFACE_COLORS.skeleton,
      }}
    >
      <div
        style={{
          ...part,
          left: (size - head) / 2,
          top: size * AVATAR_HEAD_TOP_RATIO,
          width: head,
          height: head,
        }}
      />
      <div
        style={{
          ...part,
          left: (size - body) / 2,
          top: size * AVATAR_BODY_TOP_RATIO,
          width: body,
          height: body,
        }}
      />
    </div>
  );
}

export function Author({
  geometry,
}: {
  geometry: ReviewCardGeometry;
}): ReactNode {
  return (
    <div
      style={{
        height: geometry.authorHeight,
        marginBottom: geometry.authorGap,
        display: "flex",
        alignItems: "center",
        gap: `${AUTHOR_GAP_EM}em`,
        fontFamily: FONT_FAMILY,
        fontSize: geometry.metaSize,
        lineHeight: LINE_HEIGHT.tight,
        whiteSpace: "nowrap",
      }}
    >
      <Avatar size={geometry.authorHeight} />
      <span style={{ fontWeight: FONT_WEIGHT.bold, color: COLORS.fg }}>
        {REVIEWER}
        <span
          style={{
            fontWeight: FONT_WEIGHT.regular,
            color: SURFACE_COLORS.textSecondary,
            marginLeft: `${VERB_GAP_EM}em`,
          }}
        >
          {REVIEW_VERB}
        </span>
      </span>
    </div>
  );
}
