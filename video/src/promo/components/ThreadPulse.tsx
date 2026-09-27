import type { CSSProperties, ReactNode } from "react";

import { stationAlong } from "../camera";
import { useCamera, useLayout, useSceneTime } from "../context";
import { alongCrossToPoint, type Layout, type Point } from "../layout";
import { mix, progress } from "../motion";
import { COLORS, EASE_CAMERA, GLOW_SHADOW } from "../theme";
import { TIMELINE } from "../timeline";
import { ScreenSpace } from "./Space";

const HEAD_PX = 10;
const TRAIL_PX = 180;
const TRAIL_THICKNESS_PX = 4;

export type ThreadPulseProps = {
  /** Station index and along-offset (station space px) where it starts. */
  fromStation: number;
  fromOffset?: number;
  toStation: number;
  toOffset?: number;
  /** Scene-relative start frame and travel length. */
  at: number;
  duration: number;
};

type PulseGeometry = {
  readonly head: Point;
  readonly trail: CSSProperties;
};

/** Screen geometry of the head dot and the fading trail behind it. */
function pulseGeometry(
  layout: Layout,
  from: number,
  to: number,
  p: number,
): PulseGeometry {
  const head = mix(from, to, p);
  const forward = to >= from;
  const isX = layout.axis === "x";
  const trailOrigin = alongCrossToPoint(
    layout,
    forward ? head - TRAIL_PX : head,
    layout.threadCross - TRAIL_THICKNESS_PX / 2,
  );
  const stops = forward
    ? `transparent, ${COLORS.accent2}`
    : `${COLORS.accent2}, transparent`;
  return {
    head: alongCrossToPoint(layout, head, layout.threadCross),
    trail: {
      position: "absolute",
      left: trailOrigin.x,
      top: trailOrigin.y,
      width: isX ? TRAIL_PX : TRAIL_THICKNESS_PX,
      height: isX ? TRAIL_THICKNESS_PX : TRAIL_PX,
      borderRadius: TRAIL_THICKNESS_PX,
      background: `linear-gradient(${isX ? "to right" : "to bottom"}, ${stops})`,
    },
  };
}

/**
 * A light pulse that runs along the thread (glow = accent2 25%, 24px).
 * Positions are resolved through the camera every frame, so it stays on the
 * thread during camera moves and the overview morph. Works in both
 * directions (s06 request→response, s07 back to the PR).
 */
export function ThreadPulse({
  fromStation,
  fromOffset = 0,
  toStation,
  toOffset = 0,
  at,
  duration,
}: ThreadPulseProps): ReactNode {
  const layout = useLayout();
  const camera = useCamera();
  const { frame } = useSceneTime();
  const p = progress(frame, at, duration, EASE_CAMERA);
  if (p <= 0 || p >= 1) return null;
  const count = TIMELINE.scenes.length;
  const from = stationAlong(layout, camera, fromStation, count, fromOffset);
  const to = stationAlong(layout, camera, toStation, count, toOffset);
  const { head, trail } = pulseGeometry(layout, from, to, p);
  return (
    <ScreenSpace>
      <div style={trail} />
      <div
        style={{
          position: "absolute",
          left: head.x - HEAD_PX / 2,
          top: head.y - HEAD_PX / 2,
          width: HEAD_PX,
          height: HEAD_PX,
          borderRadius: "50%",
          background: COLORS.accent2,
          boxShadow: GLOW_SHADOW,
        }}
      />
    </ScreenSpace>
  );
}
