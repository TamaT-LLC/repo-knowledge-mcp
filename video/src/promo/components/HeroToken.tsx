import type { CSSProperties, ReactNode } from "react";

import { useLayout, useSceneTime } from "../context";
import type { Point } from "../layout";
import { HERO_TOKEN_LABEL } from "../story";
import {
  COLORS,
  FONT_FAMILY,
  FONT_WEIGHT,
  GLOW_SHADOW,
  LETTER_SPACING,
  LINE_HEIGHT,
} from "../theme";
import { Reveal } from "./Reveal";
import { ScreenSpace } from "./Space";

export type TokenVariant = "outline" | "active";
export type TagVariant = "muted" | "sky" | "active";

export type TokenTag = {
  readonly text: string;
  readonly variant: TagVariant;
  /** Scene-relative frame the tag wipes in. Shown immediately if omitted. */
  readonly at?: number;
};

/** Pill padding, in em (relative to the pill's own font size). Exported so
 * DockingToken (the pill mid-flight) and ThreadBadge (its own geometry, sized
 * to mirror the pill) can share the exact same values instead of copying
 * them. */
export const PILL_PAD_CROSS_EM = 0.36;
export const PILL_PAD_ALONG_EM = 0.8;
/** Pill / tag border width. Exported for DockingToken's docking geometry. */
export const PILL_BORDER_PX = 1;
export const TAG_GAP_PX = 12;
const TAG_PAD_CROSS_EM = 0.3;
const TAG_PAD_ALONG_EM = 0.7;
/** Large enough to render a full capsule at any height. */
export const PILL_RADIUS_PX = 999;

// Outline tags get a bg fill: they sit on the thread, and without it the
// thread line would cross the middle of the text.
const TAG_STYLES: Readonly<Record<TagVariant, CSSProperties>> = {
  muted: {
    border: `${PILL_BORDER_PX}px solid ${COLORS.muted}`,
    background: COLORS.bg,
    color: COLORS.muted,
  },
  sky: {
    border: `${PILL_BORDER_PX}px solid ${COLORS.accent2}`,
    background: COLORS.bg,
    color: COLORS.accent2,
  },
  active: {
    border: `${PILL_BORDER_PX}px solid ${COLORS.accent2}`,
    background: COLORS.accent2,
    color: COLORS.bg,
  },
};

/** The pill itself, without positioning. Reuse it inside rows (s06/s07). */
export function TokenPill({
  label = HERO_TOKEN_LABEL,
  variant = "outline",
  size,
  style,
}: {
  label?: string;
  variant?: TokenVariant;
  size?: number;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  const active = variant === "active";
  return (
    <div
      style={{
        display: "inline-block",
        padding: `${PILL_PAD_CROSS_EM}em ${PILL_PAD_ALONG_EM}em`,
        borderRadius: PILL_RADIUS_PX,
        border: `${PILL_BORDER_PX}px solid ${COLORS.accent2}`,
        background: active ? COLORS.accent2 : COLORS.bg,
        color: active ? COLORS.bg : COLORS.fg,
        boxShadow: GLOW_SHADOW,
        fontFamily: FONT_FAMILY,
        fontWeight: FONT_WEIGHT.medium,
        fontSize: size ?? layout.type.token,
        lineHeight: LINE_HEIGHT.tight,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </div>
  );
}

/** Small state tag next to the token (raw evidence / proposed / active). */
export function StateTag({
  text,
  variant,
  size,
}: {
  text: string;
  variant: TagVariant;
  size?: number;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        display: "inline-block",
        padding: `${TAG_PAD_CROSS_EM}em ${TAG_PAD_ALONG_EM}em`,
        borderRadius: PILL_RADIUS_PX,
        fontFamily: FONT_FAMILY,
        fontWeight: FONT_WEIGHT.medium,
        fontSize: size ?? layout.type.tag,
        letterSpacing: LETTER_SPACING.code,
        lineHeight: LINE_HEIGHT.tight,
        whiteSpace: "nowrap",
        ...TAG_STYLES[variant],
      }}
    >
      {text}
    </div>
  );
}

export type HeroTokenProps = {
  label?: string;
  variant?: TokenVariant;
  tag?: TokenTag;
  /** Left-center point on screen. Defaults to the camera focus. */
  position?: Point;
  /** Scene-relative wipe-in frame. Visible from frame 0 if omitted. */
  enterAt?: number;
  style?: CSSProperties;
};

/**
 * The hero token riding the camera focus (screen space). Ownership rule:
 * a scene draws it only for its own frames [0, duration), so at every scene
 * boundary exactly one scene draws it, at the focus point, looking the same.
 */
export function HeroToken({
  label,
  variant,
  tag,
  position,
  enterAt,
  style,
}: HeroTokenProps): ReactNode {
  const layout = useLayout();
  const { frame, duration } = useSceneTime();
  if (frame < 0 || frame >= duration) return null;
  const point = position ?? layout.focus;
  return (
    <ScreenSpace>
      <div
        style={{
          position: "absolute",
          left: point.x,
          top: point.y,
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: TAG_GAP_PX,
          ...style,
        }}
      >
        <Reveal at={enterAt ?? Number.NEGATIVE_INFINITY}>
          <TokenPill label={label} variant={variant} />
        </Reveal>
        {tag ? (
          <Reveal at={tag.at ?? Number.NEGATIVE_INFINITY}>
            <StateTag text={tag.text} variant={tag.variant} />
          </Reveal>
        ) : null}
      </div>
    </ScreenSpace>
  );
}
