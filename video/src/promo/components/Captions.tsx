import type { ReactNode } from "react";

import { useGlobalFrame, useLayout } from "../context";
import { estimateTextWidth, type Orientation } from "../layout";
import { progress } from "../motion";
import {
  CAPTION_FADE_FRAMES,
  COLORS,
  FONT_FAMILY,
  FONT_WEIGHT,
  LINE_HEIGHT,
  SURFACE_COLORS,
} from "../theme";
import { TIMELINE, type TimelineCaption } from "../timeline";

/**
 * A touch larger than the layout's caption size. 9:16 grows less so the
 * longest chunk still fits one line of the band (see `fitCaption` below for
 * the rest: it shrinks further, then wraps, if a chunk still does not fit).
 */
const CAPTION_SIZE_BOOST_PX: Readonly<Record<Orientation, number>> = {
  landscape: 4,
  portrait: 2,
};
/** Slight tracking in the wide 16:9 band only (9:16 has no width to spare). */
const CAPTION_TRACKING_EM: Readonly<Record<Orientation, number>> = {
  landscape: 0.03,
  portrait: 0,
};
/** Never shrink a caption below this, however long the chunk. */
const MIN_CAPTION_FONT_PX = 38;
/** The 読点 nearest the middle is where an over-long chunk wraps to 2 lines. */
const LINE_BREAK_CHAR = "、";
/** The plate is a soft ellipse a little larger than the band. */
const PLATE_BLEED_X_PERCENT = 8;
const PLATE_BLEED_Y_PERCENT = 40;
const PLATE_FADE_PERCENT = 70;

const linear = (t: number): number => t;

type CaptionFit = {
  readonly fontSize: number;
  /** One entry unless the chunk still overflows at MIN_CAPTION_FONT_PX. */
  readonly lines: readonly string[];
};

/**
 * Fits `text` inside `maxWidth`: first by shrinking from `baseFontSize` down
 * to MIN_CAPTION_FONT_PX (estimateTextWidth is linear in font size, so the
 * exact size that fits can be solved directly), then, if it still does not
 * fit on one line and the box allows a second (`allowWrap`), by breaking it
 * at the 読点 closest to its midpoint.
 */
function fitCaption(
  text: string,
  maxWidth: number,
  baseFontSize: number,
  trackingEm: number,
  allowWrap: boolean,
): CaptionFit {
  const widthPerPx = estimateTextWidth(text, 1, trackingEm);
  const fits = (fontSize: number) => fontSize * widthPerPx <= maxWidth;
  if (fits(baseFontSize)) return { fontSize: baseFontSize, lines: [text] };
  const fontSize = Math.max(MIN_CAPTION_FONT_PX, maxWidth / widthPerPx);
  if (!allowWrap || fits(fontSize)) return { fontSize, lines: [text] };
  return { fontSize, lines: splitAtLineBreak(text) };
}

/** Splits at the LINE_BREAK_CHAR closest to the midpoint, else the midpoint. */
function splitAtLineBreak(text: string): readonly [string, string] {
  const chars = Array.from(text);
  const mid = chars.length / 2;
  const at = chars.reduce((best, char, i) => {
    if (char !== LINE_BREAK_CHAR) return best;
    const candidate = i + 1;
    return Math.abs(candidate - mid) < Math.abs(best - mid) ? candidate : best;
  }, Math.round(mid));
  return [chars.slice(0, at).join(""), chars.slice(at).join("")];
}

type PlacedCaption = TimelineCaption & { readonly key: string };

// Flatten once: absolute frames for every caption chunk in the timeline.
const CAPTIONS: readonly PlacedCaption[] = TIMELINE.scenes.flatMap((scene) =>
  scene.captions.map((caption, i) => ({
    key: `${scene.id}-c${i + 1}`,
    text: caption.text,
    startFrame: scene.startFrame + caption.startFrame,
    endFrame: scene.startFrame + caption.endFrame,
  })),
);

function captionOpacity(frame: number, caption: TimelineCaption): number {
  const fadeIn = progress(
    frame,
    caption.startFrame,
    CAPTION_FADE_FRAMES,
    linear,
  );
  const fadeOut = progress(
    frame,
    caption.endFrame - CAPTION_FADE_FRAMES,
    CAPTION_FADE_FRAMES,
    linear,
  );
  return Math.min(fadeIn, 1 - fadeOut);
}

/**
 * Narration captions for the whole video, straight from timeline.json.
 * Rendered once by PromoVideo (scenes never draw captions). Captions switch
 * with a 4-frame fade and never move: bottom-centre band in 16:9, inside the
 * safe area above the SNS UI in 9:16.
 */
export function Captions(): ReactNode {
  const frame = useGlobalFrame();
  const layout = useLayout();
  const box = layout.caption;
  const { orientation } = layout;
  const baseFontSize = layout.type.caption + CAPTION_SIZE_BOOST_PX[orientation];
  const trackingEm = CAPTION_TRACKING_EM[orientation];
  return CAPTIONS.map((caption) => {
    const opacity = captionOpacity(frame, caption);
    if (opacity <= 0) return null;
    const { fontSize, lines } = fitCaption(
      caption.text,
      box.width,
      baseFontSize,
      trackingEm,
      box.maxLines > 1,
    );
    return (
      <div
        key={caption.key}
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: FONT_FAMILY,
          fontWeight: FONT_WEIGHT.medium,
          fontSize,
          letterSpacing: `${trackingEm}em`,
          lineHeight: LINE_HEIGHT.caption,
          color: COLORS.caption,
          lineBreak: "strict",
          textWrap: "balance",
          whiteSpace: lines.length > 1 ? "pre-line" : "nowrap",
          opacity,
        }}
      >
        <CaptionPlate />
        <span style={{ position: "relative" }}>{lines.join("\n")}</span>
      </div>
    );
  });
}

/**
 * A very soft bg-colored ellipse behind the words: it quiets the grid and
 * the thread glow under the caption without drawing a visible box.
 */
function CaptionPlate(): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        inset: `-${PLATE_BLEED_Y_PERCENT}% -${PLATE_BLEED_X_PERCENT}%`,
        background: `radial-gradient(closest-side, ${SURFACE_COLORS.captionPlate}, transparent ${PLATE_FADE_PERCENT}%)`,
      }}
    />
  );
}
