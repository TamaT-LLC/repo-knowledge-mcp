import type { ReactNode } from "react";

import { useSceneTime } from "../context";
import type { Rect } from "../layout";
import { progress } from "../motion";
import { COLORS, EASE_ENTER } from "../theme";

// s05: the "stamp" beat of approve. A vermilion ring spreads once from the
// TTY frame's outline and is gone after 12 frames. Vermilion is allowed
// here only because this is the human's decision.

/** Storyboard: the ring spreads and disappears in 12 frames. */
const RING_FRAMES = 12;
const RING_SPREAD_PX = 40;
const RING_STROKE_PX = 2;
/** Matches TerminalFrame's corner radius. */
const FRAME_RADIUS_PX = 16;

export function StampRing({ box, at }: { box: Rect; at: number }): ReactNode {
  const { frame } = useSceneTime();
  const p = progress(frame, at, RING_FRAMES, EASE_ENTER);
  if (frame < at || p >= 1) return null;
  const spread = RING_SPREAD_PX * p;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x - spread,
        top: box.y - spread,
        width: box.width + 2 * spread,
        height: box.height + 2 * spread,
        boxSizing: "border-box",
        borderRadius: FRAME_RADIUS_PX + spread,
        border: `${RING_STROKE_PX}px solid ${COLORS.accent}`,
        opacity: 1 - p,
      }}
    />
  );
}
