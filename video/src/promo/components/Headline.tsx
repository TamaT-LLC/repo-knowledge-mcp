import type { CSSProperties, ReactNode } from "react";

import { useLayout, useSceneTime } from "../context";
import { estimateTextWidth, type Layout } from "../layout";
import {
  COLORS,
  FONT_FAMILY,
  FONT_WEIGHT,
  LETTER_SPACING,
  LINE_HEIGHT,
  STAGGER_FRAMES,
} from "../theme";
import { Reveal } from "./Reveal";
import { CODE_STYLE } from "./Text";

const HEADLINE_SPACING_EM = 0.02;
const BREAK_AFTER = "、";

/**
 * Splits a headline into display lines. Landscape: one line. Portrait: break
 * after "、" only when the whole headline does not fit (max 2 lines).
 */
export function splitHeadline(text: string, layout: Layout): string[] {
  if (layout.orientation === "landscape") return [text];
  const width = estimateTextWidth(
    text,
    layout.type.headline,
    HEADLINE_SPACING_EM,
  );
  const breakAt = text.indexOf(BREAK_AFTER);
  if (width <= layout.headline.maxWidth || breakAt < 0) return [text];
  return [text.slice(0, breakAt + 1), text.slice(breakAt + 1)];
}

function renderLine(line: string, codeTerms: readonly string[]): ReactNode {
  const term = codeTerms.find((candidate) => line.includes(candidate));
  if (!term) return line;
  const start = line.indexOf(term);
  return (
    <>
      {line.slice(0, start)}
      <span
        style={{
          ...CODE_STYLE,
          fontWeight: "inherit",
          lineHeight: "inherit",
          color: COLORS.accent2,
        }}
      >
        {term}
      </span>
      {renderLine(line.slice(start + term.length), codeTerms)}
    </>
  );
}

export type HeadlineProps = {
  text: string;
  /** Scene-relative entrance frame. Defaults to the camera arrival. */
  at?: number;
  /** Scene-relative exit frame. Defaults to the camera departure. */
  exitAt?: number | null;
  /** Explicit lines; otherwise splitHeadline() decides. */
  lines?: readonly string[];
  /** Substrings rendered as code (Space Grotesk, accent2), e.g. get_rules. */
  codeTerms?: readonly string[];
  /** Override the default position (layout.headline). */
  x?: number;
  y?: number;
  size?: number;
  style?: CSSProperties;
};

/**
 * Scene headline: Noto Sans JP 700 at the layout position, one mask wipe per
 * line (3-frame stagger). It wipes out when the camera departs so nothing is
 * left on screen when the scene unmounts. Place it inside <StationSpace>.
 */
export function Headline({
  text,
  at,
  exitAt,
  lines,
  codeTerms = [],
  x,
  y,
  size,
  style,
}: HeadlineProps): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const start = at ?? time.arrival;
  const exit = exitAt === null ? undefined : (exitAt ?? time.exitAt);
  const displayLines = lines ?? splitHeadline(text, layout);
  return (
    <div
      style={{
        position: "absolute",
        left: x ?? layout.headline.x,
        top: y ?? layout.headline.y,
        maxWidth: layout.headline.maxWidth,
        fontFamily: FONT_FAMILY,
        fontWeight: FONT_WEIGHT.bold,
        fontSize: size ?? layout.type.headline,
        letterSpacing: LETTER_SPACING.headline,
        lineHeight: LINE_HEIGHT.headline,
        color: COLORS.fg,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {displayLines.map((line, i) => (
        <Reveal
          key={line}
          at={start + i * STAGGER_FRAMES}
          exitAt={exit === undefined ? undefined : exit + i * STAGGER_FRAMES}
        >
          {renderLine(line, codeTerms)}
        </Reveal>
      ))}
    </div>
  );
}
