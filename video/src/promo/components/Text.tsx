import type { CSSProperties, ReactNode } from "react";

import { useLayout } from "../context";
import { WORDMARK } from "../story";
import {
  COLORS,
  FONT_FAMILY,
  FONT_WEIGHT,
  LETTER_SPACING,
  LINE_HEIGHT,
} from "../theme";

// Typographic primitives. They only style text; position them with <At> or
// your own absolute box, and animate them with <Reveal>.

/** Small uppercase label (station names, eyebrows, section labels). */
export function Label({
  children,
  color = COLORS.muted,
  size,
  uppercase = true,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  uppercase?: boolean;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontWeight: FONT_WEIGHT.medium,
        fontSize: size ?? layout.type.label,
        letterSpacing: LETTER_SPACING.label,
        lineHeight: LINE_HEIGHT.tight,
        textTransform: uppercase ? "uppercase" : "none",
        color,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export const CODE_STYLE: CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontWeight: FONT_WEIGHT.medium,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: LETTER_SPACING.code,
  lineHeight: LINE_HEIGHT.code,
};

/**
 * Code, paths and commands. "Code-ness" is shown with color and symbols, not
 * a monospace font: keys/commands accent2, values fg, symbols muted.
 */
export function Code({
  children,
  color = COLORS.fg,
  size,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <span
      style={{
        ...CODE_STYLE,
        fontSize: size ?? layout.type.code,
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Line prompt symbol: `$` for shells, `›` for agents. */
export function Prompt({
  symbol = "$",
  color = COLORS.muted,
}: {
  symbol?: "$" | "›" | "›_";
  color?: string;
}): ReactNode {
  return (
    <span style={{ color, marginRight: "0.5em", userSelect: "none" }}>
      {symbol}
    </span>
  );
}

/** Muted symbol (colons, separators, brackets) inside code. */
export function Sym({ children }: { children: ReactNode }): ReactNode {
  return <span style={{ color: COLORS.muted }}>{children}</span>;
}

/** The product wordmark in Space Grotesk 700. */
export function Wordmark({
  size,
  color = COLORS.fg,
  style,
}: {
  size?: number;
  color?: string;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontWeight: FONT_WEIGHT.bold,
        fontSize: size ?? layout.type.wordmark,
        letterSpacing: LETTER_SPACING.wordmark,
        lineHeight: LINE_HEIGHT.tight,
        color,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {WORDMARK}
    </div>
  );
}

/** Body text in Noto Sans JP (mixed Latin comes from Space Grotesk). */
export function BodyText({
  children,
  size,
  color = COLORS.fg,
  weight = FONT_WEIGHT.medium,
  style,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  weight?: number;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontWeight: weight,
        fontSize: size ?? layout.type.smallText,
        lineHeight: LINE_HEIGHT.body,
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** 1px separator line (fg 12%). Horizontal unless `vertical`. */
export function Hairline({
  length,
  vertical = false,
  color = COLORS.hairline,
  style,
}: {
  length: number | string;
  vertical?: boolean;
  color?: string;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div
      style={{
        width: vertical ? 1 : length,
        height: vertical ? length : 1,
        background: color,
        ...style,
      }}
    />
  );
}
