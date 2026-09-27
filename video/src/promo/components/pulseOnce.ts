import { progress } from "../motion";
import { EASE_CAMERA, EASE_ENTER } from "../theme";

/** Rise, hold and fall lengths (frames) of a one-shot highlight. */
export type PulseShape = {
  readonly rise: number;
  readonly hold: number;
  readonly fall: number;
};

/**
 * 0 → 1 → 0 exactly once: rises from `at`, holds, then falls back. Clamped,
 * so it is 0 before `at` and after the fall. Use it for "light up once"
 * cues (a badge flash, a row that brightens, a line that is highlighted).
 */
export function pulseOnce(
  frame: number,
  at: number,
  shape: PulseShape,
): number {
  const up = progress(frame, at, shape.rise, EASE_ENTER);
  const down = progress(
    frame,
    at + shape.rise + shape.hold,
    shape.fall,
    EASE_CAMERA,
  );
  return up * (1 - down);
}
