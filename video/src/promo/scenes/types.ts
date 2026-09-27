import type { ReactNode } from "react";

import type { Orientation } from "../layout";
import type { TimelineScene } from "../timeline";

/**
 * Props every scene component receives. Scenes are mounted by PromoVideo in a
 * <Sequence> from CAMERA_HALF_FRAMES before the scene until CAMERA_HALF_FRAMES
 * after it, inside a SceneProvider, so hooks such as useSceneTime() work.
 */
export type SceneProps = {
  readonly orientation: Orientation;
  /** This scene's entry in timeline.json (frames relative to its start). */
  readonly scene: TimelineScene;
  /** Index of the scene = index of its station on the thread. */
  readonly stationIndex: number;
};

export type SceneComponent = (props: SceneProps) => ReactNode;
