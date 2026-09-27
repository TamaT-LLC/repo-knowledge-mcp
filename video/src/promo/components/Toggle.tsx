import type { CSSProperties, ReactNode } from "react";
import { interpolateColors } from "remotion";

import { mix } from "../motion";
import { COLORS } from "../theme";

/** Track width. Exported so callers (e.g. OptinList) can lay out around it. */
export const TRACK_WIDTH_PX = 60;
const TRACK_HEIGHT_PX = 32;
const KNOB_PX = 22;
const BORDER_PX = 1;
const KNOB_INSET_PX = (TRACK_HEIGHT_PX - 2 * BORDER_PX - KNOB_PX) / 2;

/**
 * Opt-in switch. `on` is a 0–1 progress computed by the caller (e.g.
 * enterProgress(frame, cue, 8)). ON is painted vermilion (accent): use it
 * only for a human's explicit decision.
 */
export function Toggle({
  on,
  scale = 1,
  style,
}: {
  on: number;
  scale?: number;
  style?: CSSProperties;
}): ReactNode {
  const travel = TRACK_WIDTH_PX - 2 * BORDER_PX - KNOB_PX - 2 * KNOB_INSET_PX;
  return (
    <div
      style={{
        position: "relative",
        width: TRACK_WIDTH_PX,
        height: TRACK_HEIGHT_PX,
        boxSizing: "border-box",
        borderRadius: TRACK_HEIGHT_PX / 2,
        border: `${BORDER_PX}px solid ${interpolateColors(on, [0, 1], [COLORS.muted, COLORS.accent])}`,
        background: interpolateColors(on, [0, 1], [COLORS.bg, COLORS.accent]),
        transform: `scale(${scale})`,
        transformOrigin: "center",
        flexShrink: 0,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: KNOB_INSET_PX,
          left: KNOB_INSET_PX + mix(0, travel, on),
          width: KNOB_PX,
          height: KNOB_PX,
          borderRadius: "50%",
          background: interpolateColors(on, [0, 1], [COLORS.muted, COLORS.bg]),
        }}
      />
    </div>
  );
}
