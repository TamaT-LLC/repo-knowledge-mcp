import type { ReactNode } from "react";

import type { Point } from "../layout";
import { mix } from "../motion";
import { COLORS } from "../theme";

/** Glyph size. Exported so callers (e.g. ClickPointer's mask box) can derive
 * their own geometry from it instead of copying the number. */
export const POINTER_PX = 40;
const PRESSED_SCALE = 0.86;
const OUTLINE_PX = 2;

/**
 * Generic arrow pointer. `tip` is the hotspot in the parent's coordinates.
 * `pressed` (0–1) shrinks it slightly for a click. Animate `tip` yourself
 * with interpolate() + EASE_ENTER; never with springs.
 */
export function Pointer({
  tip,
  pressed = 0,
  opacity = 1,
}: {
  tip: Point;
  pressed?: number;
  opacity?: number;
}): ReactNode {
  return (
    <svg
      width={POINTER_PX}
      height={POINTER_PX}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{
        position: "absolute",
        left: tip.x,
        top: tip.y,
        opacity,
        transform: `scale(${mix(1, PRESSED_SCALE, pressed)})`,
        transformOrigin: "0 0",
        overflow: "visible",
      }}
    >
      <path
        d="M1 1 L1 19 L6 14.5 L9.5 22 L13 20.5 L9.6 13.2 L16 13.2 Z"
        fill={COLORS.fg}
        stroke={COLORS.bg}
        strokeWidth={OUTLINE_PX}
        strokeLinejoin="round"
      />
    </svg>
  );
}
