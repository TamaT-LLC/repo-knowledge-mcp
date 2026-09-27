import type { Layout } from "./layout";
import { progress } from "./motion";
import { HERO_COMMENT } from "./story";
import {
  CAMERA_FRAMES,
  CAMERA_HALF_FRAMES,
  EASE_CAMERA,
  OVERVIEW_MORPH_FRAMES,
  TYPE_CHARS_PER_FRAME,
} from "./theme";
import {
  type CueName,
  cueFrame,
  type Timeline,
  type TimelineScene,
} from "./timeline";

// The camera is a pure function of the global frame and timeline.json.
// Station i belongs to scene i. The camera parks on a station for the whole
// scene and moves to the next one over CAMERA_FRAMES, centred on the scene
// boundary (9 frames before, 9 after). There are no cuts.

export type CameraState = {
  /** Fractional station index the camera is focused on. */
  readonly index: number;
  /** 0 = normal spacing, 1 = overview (whole route on one screen). */
  readonly overview: number;
};

/** The overview starts at this scene's cue and ends at the next boundary. */
export const OVERVIEW_SCENE_ID = "s07-agents";
export const OVERVIEW_CUE: CueName = "c3";

function boundaryStep(frame: number, boundary: number): number {
  return progress(
    frame,
    boundary - CAMERA_HALF_FRAMES,
    CAMERA_FRAMES,
    EASE_CAMERA,
  );
}

function overviewAt(frame: number, timeline: Timeline): number {
  const index = timeline.scenes.findIndex((s) => s.id === OVERVIEW_SCENE_ID);
  if (index < 0) return 0;
  const scene = timeline.scenes[index];
  if (scene.captions.length < Number(OVERVIEW_CUE.slice(1))) return 0;
  const start = scene.startFrame + cueFrame(scene, OVERVIEW_CUE);
  const rise = progress(frame, start, OVERVIEW_MORPH_FRAMES, EASE_CAMERA);
  const next = timeline.scenes[index + 1];
  const fall = next ? boundaryStep(frame, next.startFrame) : 0;
  return rise * (1 - fall);
}

export function cameraAt(frame: number, timeline: Timeline): CameraState {
  const index = timeline.scenes
    .slice(1)
    .reduce((sum, scene) => sum + boundaryStep(frame, scene.startFrame), 0);
  return { index, overview: overviewAt(frame, timeline) };
}

/**
 * Screen coordinate on the along axis of station `stationIndex` (plus an
 * along-offset in station space) for a given camera state.
 */
export function stationAlong(
  layout: Layout,
  camera: CameraState,
  stationIndex: number,
  stationCount: number,
  offset = 0,
): number {
  const normal = (stationIndex - camera.index) * layout.stationSpacing;
  const overviewSpacing =
    (layout.overviewEnd - layout.nodeAnchor) / Math.max(1, stationCount - 1);
  const overview = stationIndex * overviewSpacing;
  return (
    layout.nodeAnchor + normal + (overview - normal) * camera.overview + offset
  );
}

/** How far station space is translated on screen (0 when parked on it). */
export function stationShift(
  layout: Layout,
  camera: CameraState,
  stationIndex: number,
  stationCount: number,
): number {
  return (
    stationAlong(layout, camera, stationIndex, stationCount) - layout.nodeAnchor
  );
}

// ---------------------------------------------------------------------------
// World timing shared by the global World layer and S01Hook.
// ---------------------------------------------------------------------------

const HOOK_SCENE_ID = "s01-hook";
/** Pause between the end of the typing and the connector/thread drawing. */
const AFTER_TYPING_GAP_FRAMES = 3;
/** The short connector from the comment down to the PR node. */
export const CONNECTOR_FRAMES = 8;
/** The thread itself grows from the PR node to the screen edge. */
export const THREAD_DRAW_FRAMES = 18;

export type HookTiming = {
  /** Scene-relative frame the comment starts typing (c1 start). */
  readonly typeStart: number;
  readonly typeEnd: number;
  readonly connectorStart: number;
  readonly threadStart: number;
  readonly threadEnd: number;
};

export function hookTiming(scene: TimelineScene): HookTiming {
  const typeStart = cueFrame(scene, "c1");
  const length = Array.from(HERO_COMMENT).length;
  const typeEnd = typeStart + Math.ceil(length / TYPE_CHARS_PER_FRAME);
  const connectorStart = typeEnd + AFTER_TYPING_GAP_FRAMES;
  const threadStart = connectorStart + CONNECTOR_FRAMES;
  return {
    typeStart,
    typeEnd,
    connectorStart,
    threadStart,
    threadEnd: threadStart + THREAD_DRAW_FRAMES,
  };
}

/** 0→1 growth of the thread in s01 (1 for every frame after it). */
export function threadReveal(frame: number, timeline: Timeline): number {
  const hook = timeline.scenes.find((scene) => scene.id === HOOK_SCENE_ID);
  if (!hook) return 1;
  const timing = hookTiming(hook);
  return progress(
    frame,
    hook.startFrame + timing.threadStart,
    THREAD_DRAW_FRAMES,
    EASE_CAMERA,
  );
}

/** Global frame at which station `index` lights up. */
export function stationLitFrame(index: number, timeline: Timeline): number {
  const scene = timeline.scenes[index];
  if (index === 0 && scene.id === HOOK_SCENE_ID) {
    return scene.startFrame + hookTiming(scene).threadEnd;
  }
  return scene.startFrame + CAMERA_HALF_FRAMES;
}
