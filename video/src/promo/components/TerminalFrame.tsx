import type { CSSProperties, ReactNode } from "react";

import { useLayout } from "../context";
import { COLORS } from "../theme";
import { Reveal } from "./Reveal";
import { CODE_STYLE, Label, Prompt } from "./Text";

const FRAME_RADIUS_PX = 16;
const FRAME_PADDING_PX = 36;
const LABEL_INSET_PX = 24;
const LABEL_PAD_PX = 10;
/**
 * Gap between rows, in em. Exported so a caller that adds its own inter-row
 * margin (e.g. ReviewTty's group spacing) can size it relative to this base
 * gap instead of guessing. Resolved against `fontSize` below: an em gap set
 * on an element with no font-size of its own falls back to the browser
 * default (16px), which is why this must be applied alongside `fontSize`.
 */
export const LINE_GAP_EM = 0.35;

/** Label notched into the top-left border of the frame. */
function FrameLabel({ text }: { text: string }): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: LABEL_INSET_PX,
        transform: "translateY(-50%)",
        padding: `0 ${LABEL_PAD_PX}px`,
        background: COLORS.bg,
      }}
    >
      <Label>{text}</Label>
    </div>
  );
}

/**
 * TTY-style frame: 1px line, 16px radius, panel fill, a label notched into
 * the top-left border. No window dots. Children are usually TerminalLine.
 *
 * `fontSize` sets the row gap's em base: rows are usually a single text size
 * (TerminalLine's own `size` prop, e.g. `layout.type.codeSmall`), so the
 * frame gap should scale with the same value rather than an unrelated
 * ambient font size.
 */
export function TerminalFrame({
  label = "TTY",
  at,
  exitAt,
  width,
  height,
  fontSize,
  children,
  style,
}: {
  label?: string;
  /** Scene-relative frame the frame wipes in. */
  at: number;
  exitAt?: number;
  width: number;
  height?: number;
  /** Row font size, for scaling the row gap (see the doc comment above). */
  fontSize: number;
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  return (
    <Reveal at={at} exitAt={exitAt} style={style}>
      <div
        style={{
          position: "relative",
          width,
          height,
          boxSizing: "border-box",
          padding: FRAME_PADDING_PX,
          border: `1px solid ${COLORS.hairlineStrong}`,
          borderRadius: FRAME_RADIUS_PX,
          background: COLORS.panel,
          display: "flex",
          flexDirection: "column",
          fontSize,
          gap: `${LINE_GAP_EM}em`,
        }}
      >
        <FrameLabel text={label} />
        {children}
      </div>
    </Reveal>
  );
}

/** One terminal row. Each row is its own element (never space-aligned). */
export function TerminalLine({
  at,
  exitAt,
  prompt,
  size,
  color = COLORS.fg,
  children,
  style,
}: {
  /** Scene-relative frame the row wipes in. */
  at: number;
  exitAt?: number;
  prompt?: "$" | "›" | "›_";
  size?: number;
  color?: string;
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <Reveal
      at={at}
      exitAt={exitAt}
      style={{
        ...CODE_STYLE,
        fontSize: size ?? layout.type.codeSmall,
        color,
        ...style,
      }}
    >
      {prompt ? <Prompt symbol={prompt} /> : null}
      {children}
    </Reveal>
  );
}
