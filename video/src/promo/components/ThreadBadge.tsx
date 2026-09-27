import type { ReactNode } from "react";

import { cameraAt, stationShift } from "../camera";
import { useLayout, useSceneMount, useSceneTime } from "../context";
import { alongCrossToPoint, estimateTextWidth, type Layout } from "../layout";
import { HERO_TOKEN_LABEL } from "../story";
import { CAMERA_FRAMES, CAMERA_HALF_FRAMES, LINE_HEIGHT } from "../theme";
import { TIMELINE } from "../timeline";
import {
  CenteredCodeBadge,
  CODE_BADGE_HEIGHT_EM,
  CODE_BADGE_PAD_ALONG_EM,
} from "./CodeBadge";
import { PILL_PAD_ALONG_EM, PILL_PAD_CROSS_EM, TokenPill } from "./HeroToken";
import { type PulseShape, pulseOnce } from "./pulseOnce";
import { ScreenSpace } from "./Space";

// A badge on the thread that the hero token passes while the camera moves
// into the station. It blinks once when the token's leading edge reaches it.
// The contact frame is derived from the camera function, so it follows any
// change to timeline.json.
/** Fully lit at the moment of contact, still lit as it slips by. */
const FLASH: PulseShape = { rise: 3, hold: 6, fall: 10 };

/** Screen along-coordinate of the token edge that meets oncoming content. */
function tokenLeadingEdge(layout: Layout): number {
  const size = layout.type.token;
  if (layout.axis === "x") {
    const text = estimateTextWidth(HERO_TOKEN_LABEL, size);
    return layout.focus.x + text + 2 * PILL_PAD_ALONG_EM * size;
  }
  const thickness = size * (LINE_HEIGHT.tight + 2 * PILL_PAD_CROSS_EM);
  return layout.focus.y + thickness / 2;
}

/** Half of the badge's length along the thread. */
function badgeHalfAlong(layout: Layout, text: string, size: number): number {
  if (layout.axis === "y") return (size * CODE_BADGE_HEIGHT_EM) / 2;
  return (
    (estimateTextWidth(text, size) + 2 * CODE_BADGE_PAD_ALONG_EM * size) / 2
  );
}

/** First scene frame of the arrival move at which the token touches it. */
function contactFrame(
  layout: Layout,
  sceneStart: number,
  station: number,
  along: number,
  halfAlong: number,
): number {
  const edge = tokenLeadingEdge(layout);
  const count = TIMELINE.scenes.length;
  const frames = Array.from(
    { length: CAMERA_FRAMES + 1 },
    (_, i) => i - CAMERA_HALF_FRAMES,
  );
  const hit = frames.find((f) => {
    const camera = cameraAt(sceneStart + f, TIMELINE);
    const shift = stationShift(layout, camera, station, count);
    return along + shift - halfAlong <= edge;
  });
  return hit ?? Number.POSITIVE_INFINITY;
}

/**
 * Badge centred on the thread at `along` (station-space along coordinate of
 * the current scene's station). Place it inside the scene's <StationSpace>.
 * It wipes in when the scene mounts (the camera is already moving) and
 * blinks once when the riding hero token reaches it. Render
 * <LeadInTokenCover /> after the StationSpace so the token stays on top.
 */
export function ThreadBadge({
  text,
  along,
  station,
}: {
  text: string;
  along: number;
  station: number;
}): ReactNode {
  const layout = useLayout();
  const { scene } = useSceneMount();
  const { frame } = useSceneTime();
  const size = layout.type.label;
  const contact = contactFrame(
    layout,
    scene.startFrame,
    station,
    along,
    badgeHalfAlong(layout, text, size),
  );
  return (
    <CenteredCodeBadge
      center={alongCrossToPoint(layout, along, layout.threadCross)}
      at={-CAMERA_HALF_FRAMES}
      text={text}
      size={size}
      flash={pulseOnce(frame, contact - FLASH.rise, FLASH)}
    />
  );
}

/**
 * The incoming scene is layered above the outgoing one, so during the
 * camera lead-in (scene frames < 0) a ThreadBadge would be drawn on top of
 * the previous scene's hero token. This re-draws the bare pill (no glow, the
 * token underneath still provides it) on top of the badge, so the token
 * keeps passing over the badge. It relies on the hand-off rule: at the
 * boundary the previous scene's token is the default pill on the focus.
 */
export function LeadInTokenCover(): ReactNode {
  const layout = useLayout();
  const { frame } = useSceneTime();
  if (frame >= 0) return null;
  return (
    <ScreenSpace>
      <div
        style={{
          position: "absolute",
          left: layout.focus.x,
          top: layout.focus.y,
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <TokenPill style={{ boxShadow: "none" }} />
      </div>
    </ScreenSpace>
  );
}
