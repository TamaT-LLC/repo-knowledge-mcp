import type { ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useSceneTime } from "../context";
import { progress } from "../motion";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  EASE_CAMERA,
  GLOW_BLUR_PX,
  PALETTE,
  THREAD_FX_COLORS,
  withAlpha,
} from "../theme";
import { Wordmark } from "./Text";

// The wordmark's landing beat: once the wipe settles, a thread-colored
// underline is drawn left to right with a bright head, the letters catch a
// brief sky glow as it lands, and the line settles to the thread's tone.

const DRAW_FRAMES = 14;
const GLOW_RISE_FRAMES = 6;
const GLOW_FALL_FRAMES = 24;
/** Peak glow alpha (the spec's accent2 25% glow). */
const GLOW_ALPHA = 0.25;
const LINE_PX = 3;
const LINE_GAP_PX = 12;
const HEAD_PX = 10;
const HEAD_HALO_PX = 28;

function Head({ at }: { at: number }): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        left: `${at * 100}%`,
        top: LINE_PX / 2,
        width: 0,
        height: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -HEAD_HALO_PX / 2,
          top: -HEAD_HALO_PX / 2,
          width: HEAD_HALO_PX,
          height: HEAD_HALO_PX,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${THREAD_FX_COLORS.nodeGlow}, transparent 70%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -HEAD_PX / 2,
          top: -HEAD_PX / 2,
          width: HEAD_PX,
          height: HEAD_PX,
          borderRadius: "50%",
          background: COLORS.fg,
        }}
      />
    </div>
  );
}

/** The underline itself: drawn to `drawn` (0–1), bright head while drawing. */
function Underline({
  drawn,
  settle,
}: {
  drawn: number;
  settle: number;
}): ReactNode {
  const isDrawing = drawn > 0 && drawn < 1;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: LINE_PX,
      }}
    >
      <div
        style={{
          width: `${drawn * 100}%`,
          height: LINE_PX,
          borderRadius: LINE_PX / 2,
          background: interpolateColors(
            settle,
            [0, 1],
            [COLORS.accent2, COLORS.threadLine],
          ),
        }}
      />
      {isDrawing ? <Head at={drawn} /> : null}
    </div>
  );
}

/**
 * The product wordmark plus its underline beat. `at` is the scene-relative
 * frame the underline starts drawing. The underline stays inside this box so
 * an enclosing <Reveal> can wipe both out together.
 */
export function WordmarkStrike({ at }: { at: number }): ReactNode {
  const { frame } = useSceneTime();
  const landed = at + DRAW_FRAMES;
  const glow =
    progress(frame, landed - GLOW_RISE_FRAMES, GLOW_RISE_FRAMES) *
    (1 - progress(frame, landed, GLOW_FALL_FRAMES));
  const textShadow = `0 0 ${GLOW_BLUR_PX}px ${withAlpha(PALETTE.accent2, GLOW_ALPHA * glow)}`;
  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        paddingBottom: LINE_GAP_PX + LINE_PX,
      }}
    >
      <Wordmark style={glow > 0 ? { textShadow } : undefined} />
      <Underline
        drawn={progress(frame, at, DRAW_FRAMES, EASE_CAMERA)}
        settle={progress(frame, landed, COLOR_SHIFT_FRAMES)}
      />
    </div>
  );
}
