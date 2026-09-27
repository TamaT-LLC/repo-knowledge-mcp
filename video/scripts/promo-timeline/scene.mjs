// Per-scene pipeline: normalize the raw narration wav to m4a, detect its
// caption pauses and turn everything into one timeline.json scene entry.
import { access } from "node:fs/promises";
import path from "node:path";

import { CAPTION_SILENCE, captionFrames, captionTiming } from "./captions.mjs";
import { FPS } from "./constants.mjs";
import { detectSilences, probeDuration } from "./ffmpeg.mjs";
import { normalizeToM4a } from "./loudness.mjs";
import { NARRATION_DIR } from "./paths.mjs";
import { speechBounds, TRIM, trimFilter } from "./trim.mjs";

const FIRST_LEAD_FRAMES = 12;
const LEAD_FRAMES = 6;
const TAIL_FRAMES = 9;
const MIN_SCENE_FRAMES = { "s08-cta": 210 };
const FRAME_EPSILON = 1e-6;

export async function processScene(scene, rawDir, publicDir) {
  const rawPath = path.join(rawDir, `${scene.id}.wav`);
  await access(rawPath).catch(() => {
    throw new Error(`Missing raw narration: ${rawPath}`);
  });
  const rawDuration = await probeDuration(rawPath);
  const edges = await detectSilences(rawPath, TRIM, rawDuration);
  const bounds = speechBounds(edges, rawDuration);
  const file = `${NARRATION_DIR}/${scene.id}.m4a`;
  const outPath = path.join(publicDir, file);
  const loudness = await normalizeToM4a(
    rawPath,
    trimFilter(bounds, rawDuration),
    outPath,
  );
  const duration = await probeDuration(outPath);
  const silences = await detectSilences(outPath, CAPTION_SILENCE, duration);
  return { file, bounds, loudness, duration, silences };
}

export function buildScene(scene, index, processed, startFrame) {
  const leadFrames = index === 0 ? FIRST_LEAD_FRAMES : LEAD_FRAMES;
  const narrationFrames = Math.ceil(processed.duration * FPS - FRAME_EPSILON);
  const timing = captionTiming(scene, processed.silences, processed.duration);
  const durationFrames = Math.max(
    leadFrames + narrationFrames + TAIL_FRAMES,
    MIN_SCENE_FRAMES[scene.id] ?? 0,
  );
  return {
    timing,
    entry: {
      id: scene.id,
      startFrame,
      durationFrames,
      narration: {
        file: processed.file,
        startFrame: leadFrames,
        durationFrames: narrationFrames,
      },
      captions: captionFrames(
        scene.captions,
        timing.boundaries,
        leadFrames,
        narrationFrames,
      ),
      captionTiming: timing.method,
    },
  };
}

export function logScene(entry, processed, timing) {
  const { bounds, loudness } = processed;
  const cuts = timing.boundaries
    .map((b) => `${b.method}@${b.end.toFixed(2)}-${b.start.toFixed(2)}s`)
    .join(" ");
  console.log(
    `${entry.id}: trim ${bounds.start.toFixed(2)}-${bounds.end.toFixed(2)}s -> ` +
      `${processed.duration.toFixed(2)}s (${entry.narration.durationFrames}f), ` +
      `scene ${entry.durationFrames}f, loudnorm ${loudness.normalization_type} ` +
      `out ${loudness.output_i} LUFS, encoded TP ${loudness.encoded_tp} dBTP` +
      (loudness.gain_db === 0
        ? ", "
        : ` (gain ${loudness.gain_db.toFixed(2)} dB), `) +
      `captions ${entry.captionTiming} [${cuts}]`,
  );
  for (const noise of bounds.dropped) {
    console.log(
      `  dropped edge noise ${noise.start.toFixed(2)}-${noise.end.toFixed(2)}s`,
    );
  }
  if (bounds.hasCutOffEnding) {
    console.warn(
      `  WARNING ${entry.id}: speech runs into the end of the raw file; ` +
        "the last mora is probably cut off. Regenerate this take.",
    );
  }
}
