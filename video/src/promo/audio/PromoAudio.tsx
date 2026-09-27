import type { ReactNode } from "react";
import { getStaticFiles, Html5Audio, Sequence, staticFile } from "remotion";

import { NARRATION_TAIL_PAD_FRAMES, NARRATION_VOLUME } from "../theme";
import { TIMELINE } from "../timeline";
import { bgmGain, SFX_VOLUME } from "./levels";

/** Background music (scripts/generate-promo-audio.py). Optional. */
export const BGM_FILE = "audio/promo/bgm.m4a";
/**
 * Camera-arrival ticks, the s04 toggle click and the s05 stamp, rendered by
 * the same script as one full-length track timed from timeline.json.
 */
export const SFX_FILE = "audio/promo/sfx.m4a";

const normalize = (path: string): string => path.replace(/^\/+/, "");

/**
 * Names of files in public/ that exist in this bundle. Audio is only placed
 * when its file exists, so renders never fail while narration or BGM is
 * still being produced.
 */
function availableFiles(): ReadonlySet<string> {
  return new Set(getStaticFiles().map((file) => normalize(file.name)));
}

export function NarrationTracks(): ReactNode {
  const available = availableFiles();
  return TIMELINE.scenes.map((scene) => {
    const file = normalize(scene.narration.file);
    if (!available.has(file)) return null;
    return (
      <Sequence
        key={scene.id}
        name={`narration ${scene.id}`}
        from={scene.startFrame + scene.narration.startFrame}
        durationInFrames={
          scene.narration.durationFrames + NARRATION_TAIL_PAD_FRAMES
        }
      >
        <Html5Audio src={staticFile(file)} volume={NARRATION_VOLUME} />
      </Sequence>
    );
  });
}

export function BgmTrack(): ReactNode {
  if (!availableFiles().has(BGM_FILE)) return null;
  return (
    <Html5Audio
      src={staticFile(BGM_FILE)}
      volume={(frame) => bgmGain(frame, TIMELINE)}
    />
  );
}

export function SfxTrack(): ReactNode {
  if (!availableFiles().has(SFX_FILE)) return null;
  return <Html5Audio src={staticFile(SFX_FILE)} volume={SFX_VOLUME} />;
}

/** Narration lines, ducked BGM and SFX, all derived from timeline.json. */
export function PromoAudio(): ReactNode {
  return (
    <>
      <NarrationTracks />
      <BgmTrack />
      <SfxTrack />
    </>
  );
}
