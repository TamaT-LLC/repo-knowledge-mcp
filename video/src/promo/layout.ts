// Orientation-specific coordinate systems.
//
// "along" = the axis the thread runs on (x in landscape, y in portrait).
// "cross" = the other axis. Scene content is authored in *station space*:
// plain canvas pixels as they appear when the camera is parked on that
// scene's station (its node sits at `nodeAnchor` on the along axis).

export type Orientation = "landscape" | "portrait";
export type Axis = "x" | "y";

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Point = { readonly x: number; readonly y: number };

export type Insets = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

export type TypeScale = {
  readonly headline: number;
  readonly wordmark: number;
  readonly wordmarkCta: number;
  readonly hero: number;
  readonly heroSmall: number;
  readonly sub: number;
  readonly code: number;
  readonly codeSmall: number;
  readonly smallText: number;
  readonly token: number;
  readonly tag: number;
  readonly label: number;
  readonly caption: number;
  readonly note: number;
};

export type Layout = {
  readonly orientation: Orientation;
  readonly width: number;
  readonly height: number;
  readonly axis: Axis;
  /** Cross-axis coordinate of the thread (y=780 / x=96). */
  readonly threadCross: number;
  /** Along-axis coordinate of the current station's node (x=120 / y=300). */
  readonly nodeAnchor: number;
  /** Distance between stations along the thread in normal mode. */
  readonly stationSpacing: number;
  /** Along-axis coordinate of the last station in the overview (s07→s08). */
  readonly overviewEnd: number;
  /** Area reserved for UI (SNS overlays in 9:16). Only bg + thread there. */
  readonly safe: Insets;
  /** Top-left of the headline block and its max width. */
  readonly headline: {
    readonly x: number;
    readonly y: number;
    readonly maxWidth: number;
  };
  /** Main content area for scene-specific elements. */
  readonly content: Rect;
  /** Caption band (screen space). */
  readonly caption: Rect & { readonly maxLines: number };
  /** Note (注記) anchor in screen space. */
  readonly note: {
    readonly x: number;
    readonly y: number;
    readonly align: "left" | "right";
  };
  /** Left-center point of the hero token when it rides the camera focus. */
  readonly focus: Point;
  /** Offset of a station label from its node (label sits beside the node). */
  readonly stationLabelOffset: Point;
  readonly type: TypeScale;
};

const LANDSCAPE: Layout = {
  orientation: "landscape",
  width: 1920,
  height: 1080,
  axis: "x",
  threadCross: 780,
  nodeAnchor: 120,
  stationSpacing: 1680,
  overviewEnd: 1800,
  safe: { top: 96, right: 120, bottom: 72, left: 120 },
  headline: { x: 120, y: 170, maxWidth: 1680 },
  content: { x: 120, y: 320, width: 1680, height: 400 },
  caption: { x: 220, y: 912, width: 1480, height: 88, maxLines: 1 },
  note: { x: 1800, y: 1012, align: "right" },
  focus: { x: 160, y: 780 },
  stationLabelOffset: { x: -7, y: 34 },
  type: {
    headline: 88,
    wordmark: 120,
    wordmarkCta: 64,
    hero: 52,
    heroSmall: 44,
    sub: 32,
    code: 40,
    codeSmall: 36,
    smallText: 26,
    token: 28,
    tag: 20,
    label: 20,
    caption: 40,
    note: 18,
  },
};

const PORTRAIT: Layout = {
  orientation: "portrait",
  width: 1080,
  height: 1920,
  axis: "y",
  threadCross: 96,
  nodeAnchor: 300,
  stationSpacing: 1500,
  overviewEnd: 1300,
  safe: { top: 240, right: 72, bottom: 400, left: 72 },
  // The station label sits right of the node at y=300, so the headline
  // starts a little lower than the storyboard's y≈280 to avoid touching it.
  headline: { x: 156, y: 340, maxWidth: 852 },
  content: { x: 156, y: 560, width: 852, height: 690 },
  // Same horizontal band as `content` (x156-1008): a wider band's left edge
  // sits close enough to the thread (x=96) that a long chunk's centred text
  // can overlap it (see Captions.tsx's font-fit fallback for the rest).
  caption: { x: 156, y: 1360, width: 852, height: 124, maxLines: 2 },
  note: { x: 156, y: 1490, align: "left" },
  focus: { x: 80, y: 1296 },
  stationLabelOffset: { x: 26, y: -12 },
  type: {
    headline: 76,
    wordmark: 80,
    wordmarkCta: 64,
    hero: 48,
    heroSmall: 44,
    sub: 30,
    code: 36,
    codeSmall: 34,
    smallText: 28,
    token: 30,
    tag: 22,
    label: 22,
    caption: 44,
    note: 20,
  },
};

export const LAYOUTS: Readonly<Record<Orientation, Layout>> = {
  landscape: LANDSCAPE,
  portrait: PORTRAIT,
};

export function getLayout(orientation: Orientation): Layout {
  return LAYOUTS[orientation];
}

/** Builds a point from along/cross coordinates for the given layout. */
export function alongCrossToPoint(
  layout: Layout,
  along: number,
  cross: number,
): Point {
  return layout.axis === "x" ? { x: along, y: cross } : { x: cross, y: along };
}

/** Moves a station-space point by `shift` along the thread axis. */
export function shiftAlong(layout: Layout, point: Point, shift: number): Point {
  return layout.axis === "x"
    ? { x: point.x + shift, y: point.y }
    : { x: point.x, y: point.y + shift };
}

const FULL_WIDTH_CODE_POINT = 0x2e80;
const HALF_WIDTH_EM = 0.58;

/**
 * Rough rendered width of a string (Latin ≈ 0.58em, CJK = 1em). Good enough
 * to decide line breaks; do not use it for pixel-exact alignment.
 */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  letterSpacingEm = 0,
): number {
  return Array.from(text).reduce((width, char) => {
    const code = char.codePointAt(0) ?? 0;
    const em = code >= FULL_WIDTH_CODE_POINT ? 1 : HALF_WIDTH_EM;
    return width + (em + letterSpacingEm) * fontSize;
  }, 0);
}
