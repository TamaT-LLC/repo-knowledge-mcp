import type { ReactNode } from "react";
import { AbsoluteFill, interpolateColors } from "remotion";

import {
  type CameraState,
  cameraAt,
  stationAlong,
  stationLitFrame,
} from "../camera";
import { useGlobalFrame, useLayout } from "../context";
import { alongCrossToPoint, type Layout } from "../layout";
import { mix, progress } from "../motion";
import { stationLabelOf } from "../story";
import { COLOR_SHIFT_FRAMES, COLORS, LETTER_SPACING } from "../theme";
import { TIMELINE } from "../timeline";
import { NodeAura, NodeRing, STATION_NODE_PX } from "./NodeRing";
import { RevealAt } from "./Reveal";
import { Label } from "./Text";
import {
  EDGE_MARGIN_PX,
  ThreadLine,
  type ThreadSpan,
  threadSpan,
} from "./ThreadLine";
import { WorldBackdrop } from "./WorldBackdrop";

// The global world layer: backdrop (light + grids), thread and station
// nodes. It is drawn once for the whole video (outside the scene sequences)
// and is driven only by the global frame and timeline.json. Scenes never
// draw these.

/** translateX(-50%) centres a label under its node. */
const CENTER_PERCENT = -50;
/** Arrival beat: the ring that widens from a node when it lights up. */
const PING_FRAMES = 26;
/** The parked station's halo breathes once per this many frames. */
const BREATH_PERIOD_FRAMES = 84;
/** Halo level of every lit node while the overview shows the whole route. */
const OVERVIEW_HALO = 0.55;
const FULL_TURN = Math.PI * 2;
const HALF = 0.5;
const LOWERCASE = /[a-z]/;
const linear = (t: number): number => t;

function StationLabel({
  layout,
  along,
  overview,
  frame,
  litFrame,
  text,
}: {
  layout: Layout;
  along: number;
  overview: number;
  frame: number;
  litFrame: number;
  text: string;
}): ReactNode {
  const node = alongCrossToPoint(layout, along, layout.threadCross);
  const isLandscape = layout.axis === "x";
  // Landscape overview: labels centre under their nodes so they fit 240px.
  const offsetX = isLandscape
    ? mix(layout.stationLabelOffset.x, 0, overview)
    : layout.stationLabelOffset.x;
  const centering = isLandscape ? CENTER_PERCENT * overview : 0;
  const lit = progress(frame, litFrame, COLOR_SHIFT_FRAMES);
  // Wide label tracking suits capitals; code-like names keep code spacing.
  const tracking = LOWERCASE.test(text) ? LETTER_SPACING.code : undefined;
  return (
    <div
      style={{
        position: "absolute",
        left: node.x + offsetX,
        top: node.y + layout.stationLabelOffset.y,
        transform: `translateX(${centering}%)`,
      }}
    >
      <RevealAt frame={frame} at={litFrame}>
        <Label
          uppercase={false}
          color={interpolateColors(lit, [0, 1], [COLORS.muted, COLORS.fg])}
          style={tracking ? { letterSpacing: tracking } : undefined}
        >
          {text}
        </Label>
      </RevealAt>
    </div>
  );
}

type NodeLight = {
  readonly halo: number;
  readonly breath: number;
  readonly ping: number;
};

/** Halo, breathing and arrival ping of station `index` at `frame`. */
function nodeLight(
  index: number,
  camera: CameraState,
  frame: number,
  litFrame: number,
  lit: number,
): NodeLight {
  const parked = Math.max(0, 1 - Math.abs(index - camera.index));
  const focus = parked * (1 - camera.overview);
  const cycle = (frame - litFrame) / BREATH_PERIOD_FRAMES;
  const breath = HALF - HALF * Math.cos(cycle * FULL_TURN);
  return {
    halo: lit * Math.max(focus, camera.overview * OVERVIEW_HALO),
    breath: frame >= litFrame ? breath * focus : 0,
    ping: progress(frame, litFrame, PING_FRAMES, linear),
  };
}

function Stations({
  layout,
  camera,
  span,
  frame,
}: {
  layout: Layout;
  camera: CameraState;
  span: ThreadSpan;
  frame: number;
}): ReactNode {
  const count = TIMELINE.scenes.length;
  const canvasLength = layout.axis === "x" ? layout.width : layout.height;
  return TIMELINE.scenes.map((scene, index) => {
    const along = stationAlong(layout, camera, index, count);
    const offCanvas =
      along < -EDGE_MARGIN_PX || along > canvasLength + EDGE_MARGIN_PX;
    const reached = span.reveal > 0 && span.end >= along - STATION_NODE_PX / 2;
    if (offCanvas || !reached) return null;
    const litFrame = stationLitFrame(index, TIMELINE);
    const lit = progress(frame, litFrame, COLOR_SHIFT_FRAMES);
    const center = alongCrossToPoint(layout, along, layout.threadCross);
    const light = nodeLight(index, camera, frame, litFrame, lit);
    return (
      <div key={scene.id}>
        <NodeAura center={center} {...light} />
        <NodeRing center={center} lit={lit} />
        <StationLabel
          layout={layout}
          along={along}
          overview={camera.overview}
          frame={frame}
          litFrame={litFrame}
          text={stationLabelOf(scene.id)}
        />
      </div>
    );
  });
}

/** Backdrop + thread + stations for the current global frame. */
export function World(): ReactNode {
  const frame = useGlobalFrame();
  const layout = useLayout();
  const camera = cameraAt(frame, TIMELINE);
  const span = threadSpan(layout, camera, frame);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <WorldBackdrop layout={layout} camera={camera} />
      <ThreadLine
        layout={layout}
        span={span}
        frame={frame}
        overview={camera.overview}
      />
      <Stations layout={layout} camera={camera} span={span} frame={frame} />
    </AbsoluteFill>
  );
}
