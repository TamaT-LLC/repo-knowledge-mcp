import type { CSSProperties, ReactNode } from "react";

import { useSceneTime } from "../context";
import { caretVisible, typedCount } from "../motion";
import { COLORS, TYPE_CHARS_PER_FRAME } from "../theme";

const CARET_WIDTH_EM = 0.08;
const CARET_HEIGHT_EM = 1.05;
const CARET_GAP_EM = 0.06;

/**
 * Thin accent2 caret. Blinks on/off from the frame; solid while `solid`.
 * Inline element: place it right after text.
 */
export function Caret({
  frame,
  solid = false,
  color = COLORS.accent2,
  style,
}: {
  frame: number;
  solid?: boolean;
  color?: string;
  style?: CSSProperties;
}): ReactNode {
  const visible = caretVisible(frame, solid);
  return (
    <span
      style={{
        display: "inline-block",
        width: `${CARET_WIDTH_EM}em`,
        height: `${CARET_HEIGHT_EM}em`,
        marginLeft: `${CARET_GAP_EM}em`,
        verticalAlign: "-0.15em",
        background: color,
        opacity: visible ? 1 : 0,
        ...style,
      }}
    />
  );
}

export type TypewriterProps = {
  text: string;
  /** Scene-relative frame the first character appears. */
  at: number;
  charsPerFrame?: number;
  /** Show a caret at the insertion point. */
  caret?: boolean;
  /** Hide the caret from this scene-relative frame on. */
  caretUntil?: number;
  /** Optional per-character color (e.g. highlight a prefix). */
  colorAt?: (index: number) => string | undefined;
  style?: CSSProperties;
};

/**
 * Types `text` at 1 character per frame. The untyped rest is rendered
 * transparent so line breaks never jump while typing.
 */
export function Typewriter({
  text,
  at,
  charsPerFrame = TYPE_CHARS_PER_FRAME,
  caret = true,
  caretUntil,
  colorAt,
  style,
}: TypewriterProps): ReactNode {
  const { frame } = useSceneTime();
  const chars = Array.from(text);
  const count = typedCount(frame, at, chars.length, charsPerFrame);
  const typing = count > 0 && count < chars.length;
  const showCaret = caret && (caretUntil === undefined || frame < caretUntil);
  const typed = chars.slice(0, count);
  return (
    <span style={style}>
      {colorAt ? (
        <ColoredRun chars={typed} colorAt={colorAt} />
      ) : (
        typed.join("")
      )}
      {showCaret ? (
        <Caret
          frame={frame}
          solid={typing}
          style={{ marginRight: `-${CARET_WIDTH_EM + CARET_GAP_EM}em` }}
        />
      ) : null}
      <span style={{ color: "transparent" }}>
        {chars.slice(count).join("")}
      </span>
    </span>
  );
}

function ColoredRun({
  chars,
  colorAt,
}: {
  chars: readonly string[];
  colorAt: (index: number) => string | undefined;
}): ReactNode {
  // Group consecutive characters that share a color into one span.
  const runs = chars.reduce<{ color: string | undefined; text: string }[]>(
    (acc, char, index) => {
      const color = colorAt(index);
      const last = acc[acc.length - 1];
      if (last && last.color === color) {
        last.text += char;
        return acc;
      }
      acc.push({ color, text: char });
      return acc;
    },
    [],
  );
  let offset = 0;
  return runs.map((run) => {
    const key = `${offset}`;
    offset += run.text.length;
    return (
      <span key={key} style={{ color: run.color }}>
        {run.text}
      </span>
    );
  });
}
