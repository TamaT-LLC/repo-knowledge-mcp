import type { ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useSceneTime } from "../context";
import { progress, typedCount } from "../motion";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  EASE_CAMERA,
  EASE_EXIT,
  LINE_HEIGHT,
  TYPE_CHARS_PER_FRAME,
} from "../theme";
import { Caret } from "./Typewriter";

// Character-level diff morph (s04): the comment turns into the rule. Kept
// text never re-types; deleted characters are struck through and then
// collapse to zero width; added characters are typed in place. Rows are
// explicit lines, so nothing reflows across lines while it morphs.
//
// The strike-through is muted, not vermilion: vermilion is reserved for the
// human's decisions (the toggle and approve), and this change is made by the
// distillation, not by a person.

export type MorphSegment = {
  readonly kind: "keep" | "del" | "add";
  readonly text: string;
};
export type MorphRow = readonly MorphSegment[];

const STRIKE_FRAMES = 8;
/** Storyboard: struck text collapses over 10 frames. */
const SHRINK_FRAMES = 10;
const STRIKE_THICKNESS_PX = 3;
/** Vertical position of the strike line inside the line box. */
const STRIKE_POSITION = "54%";
/** Wider than any glyph, so collapsing starts from the natural width. */
const CHAR_MAX_EM = 1.1;
const FULL_PERCENT = 100;

export type MorphSchedule = {
  readonly strikeAt: number;
  readonly shrinkAt: number;
  readonly typeAt: number;
  readonly doneAt: number;
};

function textOf(rows: readonly MorphRow[], kinds: readonly string[]): string {
  return rows
    .flat()
    .filter((segment) => kinds.includes(segment.kind))
    .map((segment) => segment.text)
    .join("");
}

/** Throws unless the rows spell `from` (keep+del) and `to` (keep+add). */
export function checkedMorphRows(
  rows: readonly MorphRow[],
  from: string,
  to: string,
): readonly MorphRow[] {
  if (textOf(rows, ["keep", "del"]) !== from) {
    throw new Error("DiffMorph: keep+del segments do not spell the source");
  }
  if (textOf(rows, ["keep", "add"]) !== to) {
    throw new Error("DiffMorph: keep+add segments do not spell the target");
  }
  return rows;
}

export function morphSchedule(
  strikeAt: number,
  rows: readonly MorphRow[],
): MorphSchedule {
  const shrinkAt = strikeAt + STRIKE_FRAMES;
  const typeAt = shrinkAt + SHRINK_FRAMES;
  const added = Array.from(textOf(rows, ["add"])).length;
  const doneAt = typeAt + Math.ceil(added / TYPE_CHARS_PER_FRAME);
  return { strikeAt, shrinkAt, typeAt, doneAt };
}

/** Height of one morph row for a font size. */
export function morphRowHeight(size: number): number {
  return size * LINE_HEIGHT.body;
}

type MorphColors = { readonly base: string; readonly head: string };

function DeletedText({
  text,
  schedule,
  base,
}: {
  text: string;
  schedule: MorphSchedule;
  base: string;
}): ReactNode {
  const { frame } = useSceneTime();
  const chars = Array.from(text);
  const strike = progress(frame, schedule.strikeAt, STRIKE_FRAMES, EASE_CAMERA);
  const shrink = progress(frame, schedule.shrinkAt, SHRINK_FRAMES, EASE_EXIT);
  const color = interpolateColors(
    progress(frame, schedule.strikeAt, COLOR_SHIFT_FRAMES),
    [0, 1],
    [base, COLORS.muted],
  );
  return chars.map((char, i) => {
    const drawn = Math.min(1, Math.max(0, strike * chars.length - i));
    return (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: characters repeat
        key={i}
        style={{
          display: "inline-block",
          verticalAlign: "top",
          overflow: "hidden",
          maxWidth: `${(1 - shrink) * CHAR_MAX_EM}em`,
          color,
          backgroundImage: `linear-gradient(${COLORS.muted}, ${COLORS.muted})`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: `left ${STRIKE_POSITION}`,
          backgroundSize: `${drawn * FULL_PERCENT}% ${STRIKE_THICKNESS_PX}px`,
        }}
      >
        {char}
      </span>
    );
  });
}

function AddedText({
  text,
  typeAt,
  color,
}: {
  text: string;
  typeAt: number;
  color: string;
}): ReactNode {
  const { frame } = useSceneTime();
  const chars = Array.from(text);
  const count = typedCount(frame, typeAt, chars.length, TYPE_CHARS_PER_FRAME);
  const typing = frame >= typeAt && count < chars.length;
  return (
    <span style={{ color }}>
      {chars.slice(0, count).join("")}
      {typing ? <Caret frame={frame} solid /> : null}
    </span>
  );
}

function KeptText({
  text,
  headLength,
  colors,
}: {
  text: string;
  headLength: number;
  colors: MorphColors;
}): ReactNode {
  const chars = Array.from(text);
  return (
    <span style={{ color: colors.base }}>
      <span style={{ color: colors.head }}>
        {chars.slice(0, headLength).join("")}
      </span>
      {chars.slice(headLength).join("")}
    </span>
  );
}

const segmentKey = (row: number, index: number): string => `${row}-${index}`;

/** Start frame of every "add" segment: they type one after another. */
function addStarts(
  rows: readonly MorphRow[],
  typeAt: number,
): ReadonlyMap<string, number> {
  const adds = rows.flatMap((row, r) =>
    row.flatMap((segment, i) =>
      segment.kind === "add" ? [{ key: segmentKey(r, i), segment }] : [],
    ),
  );
  const frames = (text: string): number =>
    Math.ceil(Array.from(text).length / TYPE_CHARS_PER_FRAME);
  return new Map(
    adds.map(({ key }, i) => [
      key,
      adds
        .slice(0, i)
        .reduce((at, add) => at + frames(add.segment.text), typeAt),
    ]),
  );
}

function MorphLine({
  row,
  rowIndex,
  schedule,
  starts,
  colors,
  headLength,
}: {
  row: MorphRow;
  rowIndex: number;
  schedule: MorphSchedule;
  starts: ReadonlyMap<string, number>;
  colors: MorphColors;
  headLength: number;
}): ReactNode {
  return row.map((segment, i) => {
    const key = segmentKey(rowIndex, i);
    if (segment.kind === "del") {
      return (
        <DeletedText
          key={key}
          text={segment.text}
          schedule={schedule}
          base={colors.base}
        />
      );
    }
    if (segment.kind === "add") {
      return (
        <AddedText
          key={key}
          text={segment.text}
          typeAt={starts.get(key) ?? schedule.typeAt}
          color={colors.base}
        />
      );
    }
    const head = rowIndex === 0 && i === 0 ? headLength : 0;
    return (
      <KeptText
        key={key}
        text={segment.text}
        headLength={head}
        colors={colors}
      />
    );
  });
}

export type DiffMorphProps = {
  rows: readonly MorphRow[];
  schedule: MorphSchedule;
  size: number;
  /** The text is muted until `activateAt`, then turns fg. */
  activateAt: number;
  /** Leading characters of the first row shown in accent2 once active. */
  headLength?: number;
};

/** The morphing text block (rows are block lines, never wrapped). */
export function DiffMorph({
  rows,
  schedule,
  size,
  activateAt,
  headLength = 0,
}: DiffMorphProps): ReactNode {
  const { frame } = useSceneTime();
  const active = progress(frame, activateAt, COLOR_SHIFT_FRAMES);
  const colors: MorphColors = {
    base: interpolateColors(active, [0, 1], [COLORS.muted, COLORS.fg]),
    head: interpolateColors(active, [0, 1], [COLORS.muted, COLORS.accent2]),
  };
  const starts = addStarts(rows, schedule.typeAt);
  return rows.map((row, rowIndex) => (
    <div
      key={segmentKey(rowIndex, row.length)}
      style={{ height: morphRowHeight(size), whiteSpace: "pre" }}
    >
      <MorphLine
        row={row}
        rowIndex={rowIndex}
        schedule={schedule}
        starts={starts}
        colors={colors}
        headLength={headLength}
      />
    </div>
  ));
}
