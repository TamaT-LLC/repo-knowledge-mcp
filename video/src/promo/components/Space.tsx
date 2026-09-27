import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";

import { useLayout, useStationShift } from "../context";

const LAYER: CSSProperties = { pointerEvents: "none" };

/**
 * Station space: a full-canvas layer that moves with the camera. Author
 * children in canvas pixels *as they look when the camera is parked on the
 * station* (node at x=120 / y=300). Defaults to the current scene's station.
 */
export function StationSpace({
  station,
  children,
  style,
}: {
  station?: number;
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  const shift = useStationShift(station);
  const transform =
    layout.axis === "x"
      ? `translate3d(${shift}px, 0, 0)`
      : `translate3d(0, ${shift}px, 0)`;
  return (
    <AbsoluteFill style={{ ...LAYER, transform, ...style }}>
      {children}
    </AbsoluteFill>
  );
}

/**
 * Screen space: a full-canvas layer fixed to the frame (captions, notes, the
 * hero token riding the camera focus). Anything placed here must leave by
 * the end of its scene (use Reveal's exitAt) because it does not scroll away.
 */
export function ScreenSpace({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  return <AbsoluteFill style={{ ...LAYER, ...style }}>{children}</AbsoluteFill>;
}

/** Absolutely positioned box helper (top-left anchored). */
export function At({
  x,
  y,
  width,
  children,
  style,
}: {
  x: number;
  y: number;
  width?: number;
  children: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  return (
    <div style={{ position: "absolute", left: x, top: y, width, ...style }}>
      {children}
    </div>
  );
}
