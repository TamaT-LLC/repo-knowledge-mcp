import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";

import type { CameraState } from "../camera";
import { alongCrossToPoint, type Layout } from "../layout";
import { COLORS, DEPTH_COLORS, GRID_SPACING_PX, withAlpha } from "../theme";

// The drafting-table backdrop behind the thread: a far line grid that pans
// slower than the camera (parallax), the near dot grid that pans 1:1, a faint
// sky haze along the thread by the focus, and a paper lift in the middle so
// the edges read darker (a vignette made only of palette colors). Everything
// is plain CSS gradients: no filters, so a frame stays cheap to render.

const GRID_DOT_RADIUS_PX = 1.5;
const DOT_FEATHER_PX = 0.5;
/** The far grid is four near cells wide and pans at 45% of the camera. */
const FAR_GRID_CELLS = 4;
const FAR_GRID_SPACING_PX = GRID_SPACING_PX * FAR_GRID_CELLS;
const FAR_PARALLAX = 0.45;
const FAR_LINE_PX = 1;
/** The grid fades toward the frame edges (mask alpha at the rim). */
const GRID_RIM_ALPHA = 0.3;
const GRID_CLEAR_PERCENT = 35;
/** Haze along the thread: centre ahead of the focus, stretched along it. */
const HAZE_ALONG_AHEAD_PX = 760;
const HAZE_RADIUS_ALONG_PX = 1150;
const HAZE_RADIUS_CROSS_PX = 430;
const HAZE_FADE_PERCENT = 72;
const LIFT_RADIUS_RATIO = 0.62;
const LIFT_FADE_PERCENT = 70;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Background-position string that pans a tiled layer along the thread. */
function panPosition(layout: Layout, offset: number): string {
  return layout.axis === "x" ? `${offset}px 0px` : `0px ${offset}px`;
}

function gridMask(): CSSProperties {
  const mask =
    `radial-gradient(ellipse at 50% 50%, ${COLORS.bg} ${GRID_CLEAR_PERCENT}%, ` +
    `${withAlpha(COLORS.bg, GRID_RIM_ALPHA)} 100%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

function Grids({
  layout,
  camera,
}: {
  layout: Layout;
  camera: CameraState;
}): ReactNode {
  // Both grids follow the normal-mode camera only, so they pan with every
  // station move and stay still during the overview morph.
  const travel = -camera.index * layout.stationSpacing;
  const near = positiveModulo(travel, GRID_SPACING_PX);
  const far = positiveModulo(travel * FAR_PARALLAX, FAR_GRID_SPACING_PX);
  const line = DEPTH_COLORS.gridLine;
  return (
    <AbsoluteFill style={gridMask()}>
      <AbsoluteFill
        style={{
          backgroundImage:
            `linear-gradient(to right, ${line} ${FAR_LINE_PX}px, transparent ${FAR_LINE_PX}px), ` +
            `linear-gradient(to bottom, ${line} ${FAR_LINE_PX}px, transparent ${FAR_LINE_PX}px)`,
          backgroundSize: `${FAR_GRID_SPACING_PX}px ${FAR_GRID_SPACING_PX}px`,
          backgroundPosition: panPosition(layout, far),
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(circle, ${DEPTH_COLORS.gridDot} ${GRID_DOT_RADIUS_PX}px, transparent ${GRID_DOT_RADIUS_PX + DOT_FEATHER_PX}px)`,
          backgroundSize: `${GRID_SPACING_PX}px ${GRID_SPACING_PX}px`,
          backgroundPosition: panPosition(layout, near),
        }}
      />
    </AbsoluteFill>
  );
}

function Light({ layout }: { layout: Layout }): ReactNode {
  const isX = layout.axis === "x";
  const haze = alongCrossToPoint(
    layout,
    layout.nodeAnchor + HAZE_ALONG_AHEAD_PX,
    layout.threadCross,
  );
  const hazeW = isX ? HAZE_RADIUS_ALONG_PX : HAZE_RADIUS_CROSS_PX;
  const hazeH = isX ? HAZE_RADIUS_CROSS_PX : HAZE_RADIUS_ALONG_PX;
  const liftW = layout.width * LIFT_RADIUS_RATIO;
  const liftH = layout.height * LIFT_RADIUS_RATIO;
  return (
    <AbsoluteFill
      style={{
        backgroundImage:
          `radial-gradient(${hazeW}px ${hazeH}px at ${haze.x}px ${haze.y}px, ` +
          `${DEPTH_COLORS.focusGlow}, transparent ${HAZE_FADE_PERCENT}%), ` +
          `radial-gradient(${liftW}px ${liftH}px at 50% 45%, ` +
          `${DEPTH_COLORS.centerLift}, transparent ${LIFT_FADE_PERCENT}%)`,
      }}
    />
  );
}

/** Light + grids for the current camera state (screen space). */
export function WorldBackdrop({
  layout,
  camera,
}: {
  layout: Layout;
  camera: CameraState;
}): ReactNode {
  return (
    <>
      <Light layout={layout} />
      <Grids layout={layout} camera={camera} />
    </>
  );
}
