import type { ReactNode } from "react";

import { CONNECTOR_FRAMES } from "../camera";
import { useLayout, useSceneTime } from "../context";
import { alongCrossToPoint, type Point } from "../layout";
import { exitProgress, mix, progress } from "../motion";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  EASE_CAMERA,
  THREAD_STROKE_PX,
} from "../theme";
import { NodeRing, TICK_NODE_PX } from "./NodeRing";
import { Reveal } from "./Reveal";
import { At } from "./Space";

// Thread-coloured connectors (the same 2px line as the s01 drop to the PR
// node). They belong to the thread family, so they grow along their own
// length instead of wiping, and retract back to where they started on exit.

export type ConnectorProps = {
  /** Where the line starts growing (usually on the thread). */
  from: Point;
  /** Where it ends. The segment must be horizontal or vertical. */
  to: Point;
  /** Scene-relative frame the growth starts. */
  at: number;
  duration?: number;
  /** Scene-relative frame it starts retracting toward `from`. */
  exitAt?: number;
  color?: string;
};

/** Axis-aligned 2px segment that grows from `from` to `to`. */
export function Connector({
  from,
  to,
  at,
  duration = CONNECTOR_FRAMES,
  exitAt,
  color = COLORS.threadLine,
}: ConnectorProps): ReactNode {
  const { frame } = useSceneTime();
  const grow = progress(frame, at, duration, EASE_CAMERA);
  const reach = grow * (1 - exitProgress(frame, exitAt));
  if (reach <= 0) return null;
  const end = { x: mix(from.x, to.x, reach), y: mix(from.y, to.y, reach) };
  const vertical = from.x === to.x;
  const half = THREAD_STROKE_PX / 2;
  return (
    <div
      style={{
        position: "absolute",
        left: Math.min(from.x, end.x) - (vertical ? half : 0),
        top: Math.min(from.y, end.y) - (vertical ? 0 : half),
        width: vertical ? THREAD_STROKE_PX : Math.abs(end.x - from.x),
        height: vertical ? Math.abs(end.y - from.y) : THREAD_STROKE_PX,
        background: color,
      }}
    />
  );
}

/**
 * A branch perpendicular to the thread: from the thread at `along` (station
 * space) out to the cross coordinate `cross`, starting just outside the
 * node/tick ring so the line never runs through it.
 */
export function ThreadBranch({
  along,
  cross,
  at,
  duration,
  exitAt,
  ringSize = TICK_NODE_PX,
}: {
  along: number;
  cross: number;
  at: number;
  duration?: number;
  exitAt?: number;
  /** Diameter of the ring the branch leaves from (tick or station node). */
  ringSize?: number;
}): ReactNode {
  const layout = useLayout();
  const direction = Math.sign(cross - layout.threadCross);
  const start = layout.threadCross + (direction * ringSize) / 2;
  return (
    <Connector
      from={alongCrossToPoint(layout, along, start)}
      to={alongCrossToPoint(layout, along, cross)}
      at={at}
      duration={duration}
      exitAt={exitAt}
    />
  );
}

/** Small ring on the thread at `along` that wipes in and lights up. */
export function ThreadTick({
  along,
  at,
  litAt,
  exitAt,
}: {
  along: number;
  at: number;
  litAt: number;
  exitAt?: number;
}): ReactNode {
  const layout = useLayout();
  const { frame } = useSceneTime();
  const center = alongCrossToPoint(layout, along, layout.threadCross);
  const half = TICK_NODE_PX / 2;
  return (
    <At x={center.x - half} y={center.y - half}>
      <Reveal
        at={at}
        exitAt={exitAt}
        style={{ width: TICK_NODE_PX, height: TICK_NODE_PX }}
      >
        <NodeRing
          center={{ x: half, y: half }}
          size={TICK_NODE_PX}
          lit={progress(frame, litAt, COLOR_SHIFT_FRAMES)}
        />
      </Reveal>
    </At>
  );
}
