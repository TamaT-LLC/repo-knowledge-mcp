import { createContext, type ReactNode, useContext } from "react";
import { useCurrentFrame } from "remotion";

import { type CameraState, cameraAt, stationShift } from "./camera";
import {
  getLayout,
  type Layout,
  type Orientation,
  type Point,
  shiftAlong,
} from "./layout";
import { CAMERA_HALF_FRAMES } from "./theme";
import {
  type CueName,
  cueEndFrame,
  cueFrame,
  phraseFrame,
  TIMELINE,
  type TimelineScene,
} from "./timeline";

// ---------------------------------------------------------------------------
// Video-wide context: orientation and layout.
// ---------------------------------------------------------------------------

const OrientationContext = createContext<Orientation>("landscape");

export function OrientationProvider({
  orientation,
  children,
}: {
  orientation: Orientation;
  children: ReactNode;
}): ReactNode {
  return (
    <OrientationContext.Provider value={orientation}>
      {children}
    </OrientationContext.Provider>
  );
}

export function useOrientation(): Orientation {
  return useContext(OrientationContext);
}

export function useLayout(): Layout {
  return getLayout(useOrientation());
}

// ---------------------------------------------------------------------------
// Scene context. Each scene is mounted in a <Sequence> that starts
// CAMERA_HALF_FRAMES before the scene (lead-in, while the camera arrives) and
// ends CAMERA_HALF_FRAMES after it (tail, while the camera leaves).
// ---------------------------------------------------------------------------

export type SceneMount = {
  readonly scene: TimelineScene;
  readonly index: number;
  readonly isLast: boolean;
  /** Global frame at which the scene's <Sequence> starts. */
  readonly mountFrom: number;
};

const SceneContext = createContext<SceneMount | null>(null);

export function SceneProvider({
  mount,
  children,
}: {
  mount: SceneMount;
  children: ReactNode;
}): ReactNode {
  return (
    <SceneContext.Provider value={mount}>{children}</SceneContext.Provider>
  );
}

export function useSceneMount(): SceneMount {
  const mount = useContext(SceneContext);
  if (!mount) throw new Error("useSceneMount() must be used inside a scene");
  return mount;
}

/** Absolute frame of the whole video, inside or outside a scene. */
export function useGlobalFrame(): number {
  const mount = useContext(SceneContext);
  return useCurrentFrame() + (mount?.mountFrom ?? 0);
}

export type SceneTime = {
  /** Scene-relative frame. Negative during the lead-in. */
  readonly frame: number;
  readonly duration: number;
  /** Camera has arrived; the earliest frame new content should enter. */
  readonly arrival: number;
  /** Camera starts leaving for the next station. */
  readonly departure: number;
  /** Default exit start for Headline/Note: departure, or none if last. */
  readonly exitAt: number | undefined;
  readonly isLast: boolean;
  /** Start of caption chunk c1/c2/c3… plus an optional offset in frames. */
  readonly cue: (name: CueName, offsetFrames?: number) => number;
  /** End of caption chunk c1/c2/c3… plus an optional offset in frames. */
  readonly cueEnd: (name: CueName, offsetFrames?: number) => number;
  /** Frame at which a phrase inside the captions is spoken (estimated). */
  readonly phrase: (text: string, offsetFrames?: number) => number;
};

export function useSceneTime(): SceneTime {
  const mount = useSceneMount();
  const globalFrame = useGlobalFrame();
  const { scene, isLast } = mount;
  const departure = scene.durationFrames - CAMERA_HALF_FRAMES;
  return {
    frame: globalFrame - scene.startFrame,
    duration: scene.durationFrames,
    arrival: mount.index === 0 ? 0 : CAMERA_HALF_FRAMES,
    departure,
    exitAt: isLast ? undefined : departure,
    isLast,
    cue: (name, offset = 0) => cueFrame(scene, name, offset),
    cueEnd: (name, offset = 0) => cueEndFrame(scene, name, offset),
    phrase: (text, offset = 0) => phraseFrame(scene, text, offset),
  };
}

// ---------------------------------------------------------------------------
// Camera hooks.
// ---------------------------------------------------------------------------

export function useCamera(): CameraState {
  return cameraAt(useGlobalFrame(), TIMELINE);
}

/** Along-axis screen translation of a station (current scene by default). */
export function useStationShift(stationIndex?: number): number {
  const layout = useLayout();
  const camera = useCamera();
  const mount = useContext(SceneContext);
  const index = stationIndex ?? mount?.index ?? 0;
  return stationShift(layout, camera, index, TIMELINE.scenes.length);
}

/**
 * Returns a converter from station-space points to screen points for the
 * current frame. Use it to animate something from a station-space position
 * to a screen-space one (e.g. docking the hero token under a label).
 */
export function useStationToScreen(): (
  point: Point,
  stationIndex?: number,
) => Point {
  const layout = useLayout();
  const camera = useCamera();
  const mount = useContext(SceneContext);
  return (point, stationIndex) => {
    const index = stationIndex ?? mount?.index ?? 0;
    const shift = stationShift(layout, camera, index, TIMELINE.scenes.length);
    return shiftAlong(layout, point, shift);
  };
}
