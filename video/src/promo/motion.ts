import type { CSSProperties } from "react";
import { interpolate } from "remotion";

import type { Orientation } from "./layout";
import {
  CARET_BLINK_FRAMES,
  CLAMP,
  EASE_ENTER,
  EASE_EXIT,
  ENTER_FRAMES,
  EXIT_FRAMES,
  WIPE_FEATHER_PERCENT,
} from "./theme";

// Pure helpers: frame in, value out. Nothing here reads React state, so they
// are safe to call from any component, audio volume callback or test.

type EasingFn = (t: number) => number;

/** 0→1 between `start` and `start + duration`, clamped and eased. */
export function progress(
  frame: number,
  start: number,
  duration: number,
  easing: EasingFn = EASE_ENTER,
): number {
  // Infinite starts mean "always shown" (-∞) or "never shown" (+∞).
  if (!Number.isFinite(start)) return start < 0 ? 1 : 0;
  if (duration <= 0) return frame >= start ? 1 : 0;
  return interpolate(frame, [start, start + duration], [0, 1], {
    ...CLAMP,
    easing,
  });
}

/** Entrance progress with the standard enter easing and length. */
export function enterProgress(
  frame: number,
  start: number,
  duration = ENTER_FRAMES,
): number {
  return progress(frame, start, duration, EASE_ENTER);
}

/** Exit progress (0 = fully shown, 1 = gone) with the exit easing. */
export function exitProgress(
  frame: number,
  start: number | undefined,
  duration = EXIT_FRAMES,
): number {
  if (start === undefined) return 0;
  return progress(frame, start, duration, EASE_EXIT);
}

/** Linear blend of two numbers. */
export function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Hard on/off caret blink. Always on while `solid` (e.g. while typing). */
export function caretVisible(frame: number, solid = false): boolean {
  if (solid) return true;
  return Math.floor(frame / CARET_BLINK_FRAMES) % 2 === 0;
}

/** Number of characters a typewriter shows at `frame`. */
export function typedCount(
  frame: number,
  start: number,
  length: number,
  charsPerFrame: number,
): number {
  const typed = Math.floor((frame - start + 1) * charsPerFrame);
  return Math.max(0, Math.min(length, typed));
}

const FULL = 100;

/**
 * Feathered mask wipe that follows the thread direction: left→right in
 * landscape, top→bottom in portrait. `enter` reveals from the leading edge,
 * `exit` hides from the same edge so the element "leaves" the same way.
 */
export function wipeMask(
  orientation: Orientation,
  enter: number,
  exit: number,
): CSSProperties {
  if (enter >= 1 && exit <= 0) return {};
  if (enter <= 0 || exit >= 1) return { opacity: 0 };
  const direction = orientation === "landscape" ? "to right" : "to bottom";
  const span = FULL + WIPE_FEATHER_PERCENT;
  const head = enter * span;
  const tail = exit * span - WIPE_FEATHER_PERCENT;
  const gradient =
    `linear-gradient(${direction}, ` +
    `transparent ${tail}%, black ${tail + WIPE_FEATHER_PERCENT}%, ` +
    `black ${head - WIPE_FEATHER_PERCENT}%, transparent ${head}%)`;
  return { maskImage: gradient, WebkitMaskImage: gradient };
}
