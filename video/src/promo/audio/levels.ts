import { mix, progress } from "../motion";
import {
  BGM_DB_BETWEEN_LINES,
  BGM_DB_CTA,
  BGM_DB_UNDER_NARRATION,
  BGM_DUCK_RAMP_FRAMES,
  BGM_FADE_OUT_FRAMES,
  dbToGain,
} from "../theme";
import type { Timeline } from "../timeline";

const linear = (t: number): number => t;

/**
 * SFX track level in dB relative to the file. generate-promo-audio.py peaks
 * its loudest hit (the s05 stamp) at -6 dBFS; the ticks peak 6 dB lower.
 * The track is not ducked: its hits are short and sit between words or on
 * camera arrivals.
 */
export const SFX_DB = -12;
export const SFX_VOLUME = dbToGain(SFX_DB);

export type FrameWindow = { readonly start: number; readonly end: number };

/** Absolute [start, end) of every narration line in the timeline. */
export function narrationWindows(timeline: Timeline): FrameWindow[] {
  return timeline.scenes.map((scene) => {
    const start = scene.startFrame + scene.narration.startFrame;
    return { start, end: start + scene.narration.durationFrames };
  });
}

/** 0 = silence, 1 = someone is speaking (with attack/release ramps). */
export function narrationPresence(
  frame: number,
  windows: readonly FrameWindow[],
): number {
  return windows.reduce((presence, window) => {
    const attack = progress(
      frame,
      window.start - BGM_DUCK_RAMP_FRAMES,
      BGM_DUCK_RAMP_FRAMES,
      linear,
    );
    const release = progress(frame, window.end, BGM_DUCK_RAMP_FRAMES, linear);
    return Math.max(presence, Math.min(attack, 1 - release));
  }, 0);
}

/**
 * BGM gain for a global frame: ducked to about -20 dB under narration, a
 * little higher between lines, highest in the final CTA, then faded out.
 */
export function bgmGain(frame: number, timeline: Timeline): number {
  const windows = narrationWindows(timeline);
  const lastScene = timeline.scenes[timeline.scenes.length - 1];
  const restDb =
    frame >= lastScene.startFrame ? BGM_DB_CTA : BGM_DB_BETWEEN_LINES;
  const db = mix(
    restDb,
    BGM_DB_UNDER_NARRATION,
    narrationPresence(frame, windows),
  );
  const fade =
    1 -
    progress(
      frame,
      timeline.totalFrames - BGM_FADE_OUT_FRAMES,
      BGM_FADE_OUT_FRAMES,
      linear,
    );
  return dbToGain(db) * fade;
}
