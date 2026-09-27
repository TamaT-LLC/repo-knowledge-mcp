import type { ReactNode } from "react";

import { useSceneTime } from "../context";
import type { Point } from "../layout";
import { mix, progress } from "../motion";
import {
  COLORS,
  EASE_CAMERA,
  GLOW_SHADOW,
  STAGGER_FRAMES,
  THREAD_STROKE_PX,
} from "../theme";
import { CenteredCodeBadge } from "./CodeBadge";
import { type PulseShape, pulseOnce } from "./pulseOnce";
import { Reveal } from "./Reveal";
import { At } from "./Space";
import { Code } from "./Text";

// s03: "Pull Request ──[gh CLI]──▶ (local path)". The source label, a
// connector with a gh CLI badge on it, and a light pulse that carries the
// review along the connector when it is fetched. The connector runs along
// the thread direction (right in 16:9, down in 9:16).

const ARROW_PX = 14;
const ARROW_SPREAD = 0.6;
const PULSE_DOT_PX = 10;
const PULSE_TRAVEL_FRAMES = 18;
/** The badge blinks while the pulse passes under it (the fetch). */
const BADGE_FLASH: PulseShape = { rise: 3, hold: 2, fall: 10 };
const HALF = 0.5;
const SOURCE_TEXT = "Pull Request";
const BADGE_TEXT = "gh CLI";

export type FetchFlowLayout = {
  /** Top-left of the source text, and its size. */
  readonly source: Point;
  readonly sourceSize: number;
  /** Connector start and arrow tip (same x or same y). */
  readonly from: Point;
  readonly to: Point;
  readonly badgeSize: number;
};

export type FetchFlowCues = {
  readonly sourceAt: number;
  readonly connectorAt: number;
  readonly pulseAt: number;
};

/** Frame at which the pulse reaches the arrow tip. */
export function fetchPulseEnd(pulseAt: number): number {
  return pulseAt + PULSE_TRAVEL_FRAMES;
}

function Connector({ from, to }: { from: Point; to: Point }): ReactNode {
  const left = Math.min(from.x, to.x) - ARROW_PX;
  const top = Math.min(from.y, to.y) - ARROW_PX;
  const width = Math.abs(to.x - from.x) + 2 * ARROW_PX;
  const height = Math.abs(to.y - from.y) + 2 * ARROW_PX;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const tip = { x: to.x - left, y: to.y - top };
  const back = { x: tip.x - ux * ARROW_PX, y: tip.y - uy * ARROW_PX };
  const wing = ARROW_PX * ARROW_SPREAD;
  const wings = `${back.x - uy * wing},${back.y + ux * wing} ${tip.x},${tip.y} ${back.x + uy * wing},${back.y - ux * wing}`;
  return (
    <svg
      width={width}
      height={height}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0 }}
    >
      <line
        x1={from.x - left}
        y1={from.y - top}
        x2={tip.x}
        y2={tip.y}
        stroke={COLORS.threadLine}
        strokeWidth={THREAD_STROKE_PX}
      />
      <polyline
        points={wings}
        fill="none"
        stroke={COLORS.threadLine}
        strokeWidth={THREAD_STROKE_PX}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Pulse({ flow, at }: { flow: FetchFlowLayout; at: number }): ReactNode {
  const { frame } = useSceneTime();
  const p = progress(frame, at, PULSE_TRAVEL_FRAMES, EASE_CAMERA);
  if (p <= 0 || p >= 1) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: mix(flow.from.x, flow.to.x, p) - PULSE_DOT_PX / 2,
        top: mix(flow.from.y, flow.to.y, p) - PULSE_DOT_PX / 2,
        width: PULSE_DOT_PX,
        height: PULSE_DOT_PX,
        borderRadius: "50%",
        background: COLORS.accent2,
        boxShadow: GLOW_SHADOW,
      }}
    />
  );
}

/** Source → gh CLI → arrow. Place inside <StationSpace>. */
export function FetchFlow({
  flow,
  cues,
}: {
  flow: FetchFlowLayout;
  cues: FetchFlowCues;
}): ReactNode {
  const { from, to } = flow;
  const box = {
    position: "absolute",
    left: Math.min(from.x, to.x) - ARROW_PX,
    top: Math.min(from.y, to.y) - ARROW_PX,
    width: Math.abs(to.x - from.x) + 2 * ARROW_PX,
    height: Math.abs(to.y - from.y) + 2 * ARROW_PX,
  } as const;
  const { frame } = useSceneTime();
  const middle = { x: mix(from.x, to.x, HALF), y: mix(from.y, to.y, HALF) };
  const passAt = cues.pulseAt + PULSE_TRAVEL_FRAMES * HALF - BADGE_FLASH.rise;
  return (
    <>
      <At x={flow.source.x} y={flow.source.y}>
        <Reveal at={cues.sourceAt}>
          <Code size={flow.sourceSize}>{SOURCE_TEXT}</Code>
        </Reveal>
      </At>
      <Reveal at={cues.connectorAt} style={box}>
        <Connector from={from} to={to} />
      </Reveal>
      <Pulse flow={flow} at={cues.pulseAt} />
      <CenteredCodeBadge
        center={middle}
        at={cues.connectorAt + STAGGER_FRAMES}
        text={BADGE_TEXT}
        size={flow.badgeSize}
        flash={pulseOnce(frame, passAt, BADGE_FLASH)}
      />
    </>
  );
}
