import type { CSSProperties, ReactNode } from "react";

import type { Point } from "../layout";
import { COLORS, EASE_ENTER, THREAD_FX_COLORS } from "../theme";

/** Station node: 14px ring, 2px stroke (the storyboard's spec). */
export const STATION_NODE_PX = 14;
/** Smaller tick for maps drawn on the thread (e.g. the s02 route map). */
export const TICK_NODE_PX = 10;
const RING_STROKE_PX = 2;
const LIT_DOT_RATIO = 0.43;
/** Soft glow around a lit ring, scaled with the node size. */
const LIT_GLOW_RATIO = 0.8;

/** The lit state: a brighter ring plus a filled centre dot. */
function LitOverlay({ size, lit }: { size: number; lit: number }): ReactNode {
  const dot = size * LIT_DOT_RATIO;
  const round = { position: "absolute", borderRadius: "50%" } as const;
  return (
    <>
      <div
        style={{
          ...round,
          inset: -RING_STROKE_PX,
          border: `${RING_STROKE_PX}px solid ${COLORS.accent2}`,
          boxShadow: `0 0 ${size * LIT_GLOW_RATIO}px ${THREAD_FX_COLORS.nodeGlow}`,
          opacity: lit,
        }}
      />
      <div
        style={{
          ...round,
          left: (size - dot) / 2 - RING_STROKE_PX,
          top: (size - dot) / 2 - RING_STROKE_PX,
          width: dot,
          height: dot,
          background: COLORS.accent2,
          opacity: lit,
        }}
      />
    </>
  );
}

/**
 * A ring centred on `center`. `lit` (0–1) fills the centre with accent2 and
 * brightens the ring. The ring has a bg fill so the thread never shows
 * through it.
 */
export function NodeRing({
  center,
  lit,
  size = STATION_NODE_PX,
  unlitColor = COLORS.threadLine,
  style,
}: {
  center: Point;
  lit: number;
  size?: number;
  unlitColor?: string;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        left: center.x - size / 2,
        top: center.y - size / 2,
        width: size,
        height: size,
        boxSizing: "border-box",
        borderRadius: "50%",
        border: `${RING_STROKE_PX}px solid ${unlitColor}`,
        background: COLORS.bg,
        ...style,
      }}
    >
      <LitOverlay size={size} lit={lit} />
    </div>
  );
}

/** Halo diameter and the ping's final diameter, in node sizes. */
const HALO_SCALE = 4.2;
const HALO_BREATH_GROWTH = 0.18;
const HALO_REST_OPACITY = 0.65;
const PING_END_SCALE = 3.4;
const PING_STROKE_PX = 1.5;
const PING_PEAK_OPACITY = 0.7;

/**
 * Light around a node, drawn beneath it: a soft halo (`halo` 0–1, grows a
 * little with `breath` 0–1) and a one-shot ring that widens and fades as
 * `ping` runs 0→1 linearly (the arrival beat).
 */
export function NodeAura({
  center,
  halo,
  breath = 0,
  ping = 0,
  size = STATION_NODE_PX,
}: {
  center: Point;
  halo: number;
  breath?: number;
  ping?: number;
  size?: number;
}): ReactNode {
  const haloSize = size * HALO_SCALE * (1 + HALO_BREATH_GROWTH * breath);
  // The ring spreads fast then settles (ease-out) while it fades linearly.
  const spread = EASE_ENTER(ping);
  const pingSize = size + (size * PING_END_SCALE - size) * spread;
  const isPinging = ping > 0 && ping < 1;
  const round = { position: "absolute", borderRadius: "50%" } as const;
  return (
    <>
      {halo > 0 ? (
        <div
          style={{
            ...round,
            left: center.x - haloSize / 2,
            top: center.y - haloSize / 2,
            width: haloSize,
            height: haloSize,
            background: `radial-gradient(circle, ${THREAD_FX_COLORS.nodeHalo}, transparent 70%)`,
            opacity:
              halo * (HALO_REST_OPACITY + (1 - HALO_REST_OPACITY) * breath),
          }}
        />
      ) : null}
      {isPinging ? (
        <div
          style={{
            ...round,
            boxSizing: "border-box",
            left: center.x - pingSize / 2,
            top: center.y - pingSize / 2,
            width: pingSize,
            height: pingSize,
            border: `${PING_STROKE_PX}px solid ${COLORS.accent2}`,
            opacity: PING_PEAK_OPACITY * (1 - ping),
          }}
        />
      ) : null}
    </>
  );
}
