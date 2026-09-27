import type { ReactNode } from "react";
import { AbsoluteFill, Sequence } from "remotion";

import { PromoAudio } from "./audio/PromoAudio";
import { Captions } from "./components/Captions";
import { World } from "./components/World";
import { OrientationProvider, SceneProvider } from "./context";
import type { Orientation } from "./layout";
import { sceneComponentOf } from "./scenes/registry";
import { CAMERA_HALF_FRAMES, COLORS, FONT_FAMILY } from "./theme";
import { TIMELINE, type TimelineScene } from "./timeline";

export type PromoVideoProps = {
  readonly orientation: Orientation;
};

/**
 * Mounts one scene from CAMERA_HALF_FRAMES before its start (the camera is
 * arriving) to CAMERA_HALF_FRAMES after its end (the camera is leaving), so
 * scene content can scroll in and out with the world without any cut.
 */
function SceneMount({
  scene,
  index,
  orientation,
}: {
  scene: TimelineScene;
  index: number;
  orientation: Orientation;
}): ReactNode {
  const lastIndex = TIMELINE.scenes.length - 1;
  const mountFrom = Math.max(0, scene.startFrame - CAMERA_HALF_FRAMES);
  const mountTo = Math.min(
    TIMELINE.totalFrames,
    scene.startFrame + scene.durationFrames + CAMERA_HALF_FRAMES,
  );
  const Scene = sceneComponentOf(scene.id);
  return (
    <Sequence
      from={mountFrom}
      durationInFrames={mountTo - mountFrom}
      name={scene.id}
    >
      <SceneProvider
        mount={{ scene, index, isLast: index === lastIndex, mountFrom }}
      >
        <Scene orientation={orientation} scene={scene} stationIndex={index} />
      </SceneProvider>
    </Sequence>
  );
}

/**
 * The narrated promo. Layers, back to front: world (grid, thread, stations),
 * scenes, captions. Audio (narration + ducked BGM) is placed only for files
 * that exist in public/. Every frame is derived from timeline.json.
 */
export function PromoVideo({ orientation }: PromoVideoProps): ReactNode {
  return (
    <OrientationProvider orientation={orientation}>
      <AbsoluteFill
        style={{
          backgroundColor: COLORS.bg,
          fontFamily: FONT_FAMILY,
          overflow: "hidden",
        }}
      >
        <World />
        {TIMELINE.scenes.map((scene, index) => (
          <SceneMount
            key={scene.id}
            scene={scene}
            index={index}
            orientation={orientation}
          />
        ))}
        <Captions />
        <PromoAudio />
      </AbsoluteFill>
    </OrientationProvider>
  );
}
