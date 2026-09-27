import type { ReactNode } from "react";

import { type CameraState, stationAlong, threadReveal } from "../camera";
import { alongCrossToPoint, type Layout } from "../layout";
import {
  COLORS,
  THREAD_DASH_GAP_PX,
  THREAD_DASH_PX,
  THREAD_FLOW_PX_PER_FRAME,
  THREAD_FX_COLORS,
  THREAD_STROKE_PX,
} from "../theme";
import { TIMELINE } from "../timeline";

// The thread: a soft two-step glow under the 2px line, the dotted overlay
// that flows 1px per frame, slow comets of light that travel forward (data
// on the move) and a bright spark at the tip while s01 draws the line.
// All of it is plain SVG strokes and shapes: no blur filters.

/** Off-canvas margin so line ends and labels never pop at the edges. */
export const EDGE_MARGIN_PX = 480;
const HALO_STROKE_PX = 12;
const CORE_STROKE_PX = 5;
/** Comets: spacing along the thread, travel speed and streak shape. */
const COMET_PERIOD_PX = 620;
const COMET_SPEED_PX_PER_FRAME = 4;
const COMET_TAIL_PX = 220;
const COMET_CORE_PX = 2.5;
const COMET_GLOW_PX = 10;
const COMET_GLOW_OPACITY = 0.22;
const COMET_HEAD_RADIUS_PX = 2;
/** The drawing tip in s01. */
const SPARK_RADIUS_PX = 4;
const SPARK_HALO_RADIUS_PX = 13;
const CORE_GRADIENT_ID = "world-thread-comet-core";
const GLOW_GRADIENT_ID = "world-thread-comet-glow";

export type ThreadSpan = {
  readonly first: number;
  readonly end: number;
  /** s01 growth progress (0 before the thread exists). */
  readonly reveal: number;
  /** On-screen length of one station step / normal step (1 → overview). */
  readonly scale: number;
};

function canvasLength(layout: Layout): number {
  return layout.axis === "x" ? layout.width : layout.height;
}

export function threadSpan(
  layout: Layout,
  camera: CameraState,
  frame: number,
): ThreadSpan {
  const count = TIMELINE.scenes.length;
  const first = stationAlong(layout, camera, 0, count);
  const second = stationAlong(layout, camera, 1, count);
  const last = stationAlong(layout, camera, count - 1, count);
  const reveal = threadReveal(frame, TIMELINE);
  const canvasEnd = canvasLength(layout) + 1;
  const end =
    reveal >= 1 ? last : first + reveal * (Math.min(last, canvasEnd) - first);
  return {
    first,
    end,
    reveal,
    scale: (second - first) / layout.stationSpacing,
  };
}

type CometHead = { readonly id: number; readonly along: number };

/** Head positions (along axis) of the comets that are on screen now. */
function cometHeads(
  layout: Layout,
  span: ThreadSpan,
  frame: number,
): CometHead[] {
  // Positions live in normal-mode px scaled by the overview, so comets ride
  // with the world during camera moves and compress with the overview.
  const step = COMET_PERIOD_PX * span.scale;
  const phase =
    ((frame * COMET_SPEED_PX_PER_FRAME) % COMET_PERIOD_PX) * span.scale;
  const lo = Math.max(span.first, -EDGE_MARGIN_PX);
  const hi = Math.min(span.end, canvasLength(layout) + EDGE_MARGIN_PX);
  const firstK = Math.ceil((lo - span.first - phase) / step);
  const lastK = Math.floor((hi - span.first - phase) / step);
  const count = Math.max(0, lastK - firstK + 1);
  return Array.from({ length: count }, (_, i) => {
    const k = firstK + i;
    return { id: k, along: span.first + phase + k * step };
  });
}

/** A rounded bar on the thread from `tail` to `head` (along axis). */
function Streak({
  layout,
  tail,
  head,
  thickness,
  gradientId,
}: {
  layout: Layout;
  tail: number;
  head: number;
  thickness: number;
  gradientId: string;
}): ReactNode {
  const isX = layout.axis === "x";
  const origin = alongCrossToPoint(
    layout,
    tail,
    layout.threadCross - thickness / 2,
  );
  const length = head - tail;
  return (
    <rect
      x={origin.x}
      y={origin.y}
      width={isX ? length : thickness}
      height={isX ? thickness : length}
      rx={thickness / 2}
      fill={`url(#${gradientId})`}
    />
  );
}

/** A streak of light: soft glow, bright core and a pale head. */
function Comet({
  layout,
  head,
  tailStart,
}: {
  layout: Layout;
  head: number;
  tailStart: number;
}): ReactNode {
  const tail = Math.max(tailStart, head - COMET_TAIL_PX);
  if (head <= tail) return null;
  const tip = alongCrossToPoint(layout, head, layout.threadCross);
  const streak = { layout, tail, head };
  return (
    <>
      <Streak
        {...streak}
        thickness={COMET_GLOW_PX}
        gradientId={GLOW_GRADIENT_ID}
      />
      <Streak
        {...streak}
        thickness={COMET_CORE_PX}
        gradientId={CORE_GRADIENT_ID}
      />
      <circle cx={tip.x} cy={tip.y} r={COMET_HEAD_RADIUS_PX} fill={COLORS.fg} />
    </>
  );
}

/** Along-axis gradients (transparent tail → bright head) for the streaks. */
function CometGradients({ isX }: { isX: boolean }): ReactNode {
  const direction = {
    x1: "0",
    y1: "0",
    x2: isX ? "1" : "0",
    y2: isX ? "0" : "1",
  };
  return (
    <defs>
      <linearGradient id={CORE_GRADIENT_ID} {...direction}>
        <stop offset="0" stopColor={COLORS.accent2} stopOpacity={0} />
        <stop offset="1" stopColor={COLORS.accent2} stopOpacity={1} />
      </linearGradient>
      <linearGradient id={GLOW_GRADIENT_ID} {...direction}>
        <stop offset="0" stopColor={COLORS.accent2} stopOpacity={0} />
        <stop
          offset="1"
          stopColor={COLORS.accent2}
          stopOpacity={COMET_GLOW_OPACITY}
        />
      </linearGradient>
    </defs>
  );
}

function Spark({
  layout,
  along,
}: {
  layout: Layout;
  along: number;
}): ReactNode {
  const tip = alongCrossToPoint(layout, along, layout.threadCross);
  return (
    <>
      <circle
        cx={tip.x}
        cy={tip.y}
        r={SPARK_HALO_RADIUS_PX}
        fill={THREAD_FX_COLORS.sparkHalo}
      />
      <circle cx={tip.x} cy={tip.y} r={SPARK_RADIUS_PX} fill={COLORS.fg} />
    </>
  );
}

export function ThreadLine({
  layout,
  span,
  frame,
  overview,
}: {
  layout: Layout;
  span: ThreadSpan;
  frame: number;
  overview: number;
}): ReactNode {
  const start = Math.max(span.first, -EDGE_MARGIN_PX);
  const end = Math.min(span.end, canvasLength(layout) + EDGE_MARGIN_PX);
  if (end <= start) return null;
  const a = alongCrossToPoint(layout, start, layout.threadCross);
  const b = alongCrossToPoint(layout, end, layout.threadCross);
  // The dotted overlay is anchored to the line's origin (so it scrolls with
  // the world) and also flows forward by 1px per frame.
  const dashOffset = start - span.first - frame * THREAD_FLOW_PX_PER_FRAME;
  const line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const isX = layout.axis === "x";
  const isDrawing = span.reveal > 0 && span.reveal < 1;
  // Comets fade in while s01 draws the line and make way for the reverse
  // light pulse of the overview (s07).
  const cometOpacity = span.reveal * (1 - overview);
  return (
    <svg
      width={layout.width}
      height={layout.height}
      style={{ position: "absolute", inset: 0 }}
      aria-hidden="true"
    >
      <CometGradients isX={isX} />
      <line
        {...line}
        stroke={THREAD_FX_COLORS.halo}
        strokeWidth={HALO_STROKE_PX}
        strokeLinecap="round"
      />
      <line
        {...line}
        stroke={THREAD_FX_COLORS.core}
        strokeWidth={CORE_STROKE_PX}
        strokeLinecap="round"
      />
      <line
        {...line}
        stroke={COLORS.threadLine}
        strokeWidth={THREAD_STROKE_PX}
      />
      <line
        {...line}
        stroke={COLORS.threadDash}
        strokeWidth={THREAD_STROKE_PX}
        strokeDasharray={`${THREAD_DASH_PX} ${THREAD_DASH_GAP_PX}`}
        strokeDashoffset={dashOffset}
      />
      {cometOpacity > 0 ? (
        <g opacity={cometOpacity}>
          {cometHeads(layout, span, frame).map((head) => (
            <Comet
              key={head.id}
              layout={layout}
              head={head.along}
              tailStart={span.first}
            />
          ))}
        </g>
      ) : null}
      {isDrawing ? <Spark layout={layout} along={end} /> : null}
    </svg>
  );
}
