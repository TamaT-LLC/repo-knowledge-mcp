import type { ReactNode } from "react";

import { useLayout, useSceneTime } from "../context";
import type { Point } from "../layout";
import { mix, progress } from "../motion";
import { EASE_CAMERA } from "../theme";
import {
  HeroToken,
  PILL_BORDER_PX,
  PILL_PAD_ALONG_EM,
  StateTag,
  TAG_GAP_PX,
  TokenPill,
  type TokenTag,
  type TokenVariant,
} from "./HeroToken";
import { Reveal } from "./Reveal";
import { ScreenSpace } from "./Space";

// The hero token leaving the camera focus to dock on a line of text that
// starts with the same words, then dissolving into it with a wipe.
//
// Until `slideAt` it *is* the shared <HeroToken> (same props as the previous
// scene's last frame). From `slideAt` on it is redrawn here with the same
// geometry (TAG_GAP_PX, PILL_PAD_ALONG_EM, PILL_BORDER_PX, all imported from
// HeroToken) so the pill can grow to the target font size and travel.

export type DockingTokenProps = {
  label?: string;
  variant?: TokenVariant;
  /** Tag carried from the previous scene. It wipes out as the slide starts. */
  tag?: TokenTag;
  /** Scene-relative frame the token leaves the focus. */
  slideAt: number;
  slideFrames: number;
  /** Screen point where the docked label text starts, on its centre line. */
  target: Point;
  /** Font size of the text the token docks on. */
  targetSize: number;
  /** Scene-relative frame the docked pill wipes out, revealing the text. */
  absorbAt: number;
};

/** Frame from which the pill fully covers the docking slot. */
export function dockedFrame(slideAt: number, slideFrames: number): number {
  return slideAt + slideFrames;
}

export function DockingToken({
  label,
  variant,
  tag,
  slideAt,
  slideFrames,
  target,
  targetSize,
  absorbAt,
}: DockingTokenProps): ReactNode {
  const layout = useLayout();
  const { frame, duration } = useSceneTime();
  if (frame < slideAt) {
    return <HeroToken label={label} variant={variant} tag={tag} />;
  }
  if (frame >= duration) return null;
  const p = progress(frame, slideAt, slideFrames, EASE_CAMERA);
  const size = mix(layout.type.token, targetSize, p);
  const dockedLeft = target.x - PILL_BORDER_PX - PILL_PAD_ALONG_EM * targetSize;
  return (
    <ScreenSpace>
      <div
        style={{
          position: "absolute",
          left: mix(layout.focus.x, dockedLeft, p),
          top: mix(layout.focus.y, target.y, p),
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: TAG_GAP_PX,
        }}
      >
        <Reveal at={Number.NEGATIVE_INFINITY} exitAt={absorbAt}>
          <TokenPill label={label} variant={variant} size={size} />
        </Reveal>
        {tag ? (
          <Reveal at={Number.NEGATIVE_INFINITY} exitAt={slideAt}>
            <StateTag text={tag.text} variant={tag.variant} />
          </Reveal>
        ) : null}
      </div>
    </ScreenSpace>
  );
}
