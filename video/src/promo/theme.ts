import { Easing } from "remotion";

import { sans } from "../fonts";
import script from "./script.json";

// ---------------------------------------------------------------------------
// Color: the five palette tokens come from script.json (the source of truth).
// accent (vermilion) is reserved for moments of human judgement only.
// accent2 (sky) is for the thread, data, agents and the hero token.
// ---------------------------------------------------------------------------
export const PALETTE = script.palette;

const HEX_RADIX = 16;
const HEX_BODY = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Returns `hex` (#RRGGBB) as an rgba() string with the given alpha (0–1). */
export function withAlpha(hex: string, alpha: number): string {
  const match = HEX_BODY.exec(hex);
  if (!match) throw new Error(`withAlpha expects #RRGGBB, got "${hex}"`);
  const [r, g, b] = match
    .slice(1)
    .map((part) => Number.parseInt(part, HEX_RADIX));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Derived colors. Never add new hues: derive from fg/accent2 opacity. */
export const COLORS = {
  ...PALETTE,
  hairline: withAlpha(PALETTE.fg, 0.12),
  hairlineStrong: withAlpha(PALETTE.fg, 0.24),
  panel: withAlpha(PALETTE.fg, 0.05),
  gridDot: withAlpha(PALETTE.fg, 0.04),
  caption: withAlpha(PALETTE.fg, 0.92),
  glow: withAlpha(PALETTE.accent2, 0.25),
  threadLine: withAlpha(PALETTE.accent2, 0.55),
  threadDash: withAlpha(PALETTE.accent2, 0.9),
} as const;

/** Blur radius of the accent2 glow (hero token and light pulses only). */
export const GLOW_BLUR_PX = 24;
export const GLOW_SHADOW = `0 0 ${GLOW_BLUR_PX}px ${COLORS.glow}`;

// ---------------------------------------------------------------------------
// Type: one stack for everything. Latin glyphs come from Space Grotesk,
// Japanese from Noto Sans JP. System monospace fonts are never used.
// ---------------------------------------------------------------------------
export const FONT_FAMILY = sans;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  bold: 700,
} as const;

export const LETTER_SPACING = {
  headline: "0.02em",
  label: "0.12em",
  code: "0.01em",
  wordmark: "-0.01em",
} as const;

export const LINE_HEIGHT = {
  headline: 1.3,
  body: 1.5,
  /** >= 1.3 so the underscore of get_rules is never clipped. */
  code: 1.35,
  caption: 1.4,
  tight: 1.15,
} as const;

// ---------------------------------------------------------------------------
// Motion. No springs, no bounces, no CSS transitions: every value is derived
// from useCurrentFrame() through interpolate() with clamping.
// ---------------------------------------------------------------------------
export const EASE_ENTER = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_EXIT = Easing.bezier(0.64, 0, 0.78, 0);
export const EASE_CAMERA = Easing.bezier(0.65, 0, 0.35, 1);

export const CLAMP = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Entrance (mask wipe) length. The spec allows 14–18 frames. */
export const ENTER_FRAMES = 16;
/** Exit (mask wipe out) length. The spec allows 8–10 frames. */
export const EXIT_FRAMES = 9;
/** Camera move between stations; straddles the scene boundary. */
export const CAMERA_FRAMES = 18;
/** Half of the camera move: 9 frames before and 9 after each boundary. */
export const CAMERA_HALF_FRAMES = CAMERA_FRAMES / 2;
/** Overview morph (s07 c3): station spacing shrinks instead of scaling. */
export const OVERVIEW_MORPH_FRAMES = 24;
/** Delay between siblings that enter one after another. */
export const STAGGER_FRAMES = 3;
/** Typewriter speed. */
export const TYPE_CHARS_PER_FRAME = 1;
/** Caption chunk fade in / fade out length (captions never move). */
export const CAPTION_FADE_FRAMES = 4;
/** Caret blink half-period (on for N frames, off for N frames). */
export const CARET_BLINK_FRAMES = 16;
/** Color changes (muted -> fg, unlit -> lit) that are not wipes. */
export const COLOR_SHIFT_FRAMES = 8;
/** Soft edge of the mask wipe, in percent of the element's length. */
export const WIPE_FEATHER_PERCENT = 12;
/** The dotted overlay on the thread flows this many px per frame. */
export const THREAD_FLOW_PX_PER_FRAME = 1;
export const THREAD_DASH_PX = 2;
export const THREAD_DASH_GAP_PX = 12;
export const THREAD_STROKE_PX = 2;
export const GRID_SPACING_PX = 48;

// ---------------------------------------------------------------------------
// Audio. Levels are dB relative to the full-scale BGM file.
// ---------------------------------------------------------------------------
export const NARRATION_VOLUME = 1;
export const BGM_DB_UNDER_NARRATION = -20;
export const BGM_DB_BETWEEN_LINES = -10;
export const BGM_DB_CTA = -7;
/** Duck attack (before a line starts) and release (after it ends). */
export const BGM_DUCK_RAMP_FRAMES = 8;
export const BGM_FADE_OUT_FRAMES = 20;
/** Extra frames kept after each narration clip so tails are not cut. */
export const NARRATION_TAIL_PAD_FRAMES = 3;

const DB_PER_DECADE = 20;
const DECIBEL_BASE = 10;

export function dbToGain(db: number): number {
  return DECIBEL_BASE ** (db / DB_PER_DECADE);
}

// ---------------------------------------------------------------------------
// Depth, surfaces and the living thread (polish pass; additions only). Still
// only palette colors through withAlpha(). Background lifts are capped so that
// muted text keeps >= 6:1 on the brightest background pixel.
// ---------------------------------------------------------------------------
export const DEPTH_COLORS = {
  /** Near dot grid: moves 1:1 with the camera. */
  gridDot: withAlpha(PALETTE.fg, 0.08),
  /** Far line grid: moves slower than the camera (parallax). */
  gridLine: withAlpha(PALETTE.fg, 0.03),
  /** Sky haze along the thread near the focus (<= 3%: contrast cap). */
  focusGlow: withAlpha(PALETTE.accent2, 0.02),
  /** Faint paper lift in the middle of the frame; edges stay pure bg. */
  centerLift: withAlpha(PALETTE.fg, 0.008),
} as const;

export const SURFACE_COLORS = {
  /** Raised card (review comment). muted drops below 6:1 on it. */
  card: withAlpha(PALETTE.fg, 0.03),
  cardHeader: withAlpha(PALETTE.fg, 0.03),
  cardBorder: withAlpha(PALETTE.fg, 0.16),
  /** Secondary text on raised surfaces (>= 7:1 there, unlike muted). */
  textSecondary: withAlpha(PALETTE.fg, 0.7),
  textSubtle: withAlpha(PALETTE.fg, 0.66),
  /** Abstract code bars in the diff preview. */
  skeleton: withAlpha(PALETTE.fg, 0.1),
  skeletonHot: withAlpha(PALETTE.accent2, 0.26),
  lineHighlight: withAlpha(PALETTE.accent2, 0.08),
  /** Soft plate under captions (hides the grid behind the words). */
  captionPlate: withAlpha(PALETTE.bg, 0.8),
} as const;

export const THREAD_FX_COLORS = {
  halo: withAlpha(PALETTE.accent2, 0.045),
  core: withAlpha(PALETTE.accent2, 0.1),
  sparkHalo: withAlpha(PALETTE.accent2, 0.2),
  nodeHalo: withAlpha(PALETTE.accent2, 0.22),
  nodeGlow: withAlpha(PALETTE.accent2, 0.45),
} as const;
