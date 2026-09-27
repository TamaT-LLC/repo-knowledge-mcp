#!/usr/bin/env node
// Builds the promo narration (m4a) and src/promo/timeline.json from raw TTS wavs.
// Usage: node scripts/build-promo-timeline.mjs --raw <dir>  (files: <scene-id>.wav)
//
// The implementation lives in scripts/promo-timeline/ (ffmpeg wrappers, edge
// trim, loudness normalization, caption timing and the per-scene pipeline);
// this file is the entry point kept at its historical path so
// `npm run timeline:promo` keeps working.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_VOICE, FPS } from "./promo-timeline/constants.mjs";
import {
  NARRATION_DIR,
  PUBLIC_DIR,
  SCRIPT_PATH,
  TIMELINE_PATH,
  VIDEO_ROOT,
} from "./promo-timeline/paths.mjs";
import { buildScene, logScene, processScene } from "./promo-timeline/scene.mjs";

function readOptions() {
  const { values } = parseArgs({
    options: {
      raw: { type: "string" },
      "out-dir": { type: "string" },
      "voice-id": { type: "string" },
      "voice-name": { type: "string" },
      "speech-rate": { type: "string" },
    },
  });
  if (!values.raw) {
    throw new Error(
      "Usage: node scripts/build-promo-timeline.mjs --raw <dir> " +
        "[--out-dir <dir>] [--voice-id <id>] [--voice-name <name>] " +
        "[--speech-rate <n>]",
    );
  }
  const speechRate = values["speech-rate"];
  return {
    rawDir: path.resolve(values.raw),
    // Redirects narration output and timeline.json under one directory,
    // instead of public/ and src/promo/timeline.json, for dry runs (e.g.
    // verifying a refactor never touches the checked-in files).
    outDir: values["out-dir"] ? path.resolve(values["out-dir"]) : null,
    voice: {
      model: DEFAULT_VOICE.model,
      voiceId: values["voice-id"] ?? DEFAULT_VOICE.voiceId,
      voiceName: values["voice-name"] ?? DEFAULT_VOICE.voiceName,
      speechRate:
        speechRate === undefined
          ? DEFAULT_VOICE.speechRate
          : Number(speechRate),
    },
  };
}

async function main() {
  const { rawDir, outDir, voice } = readOptions();
  const script = JSON.parse(await readFile(SCRIPT_PATH, "utf8"));
  if (script.fps !== FPS) throw new Error(`Expected ${FPS} fps script`);
  const publicDir = outDir ?? PUBLIC_DIR;
  const timelinePath = outDir
    ? path.join(outDir, "timeline.json")
    : TIMELINE_PATH;
  await mkdir(path.join(publicDir, NARRATION_DIR), { recursive: true });
  const scenes = [];
  let startFrame = 0;
  for (const [index, scene] of script.scenes.entries()) {
    const processed = await processScene(scene, rawDir, publicDir);
    const { entry, timing } = buildScene(scene, index, processed, startFrame);
    logScene(entry, processed, timing);
    scenes.push(entry);
    startFrame += entry.durationFrames;
  }
  const timeline = { fps: FPS, totalFrames: startFrame, voice, scenes };
  await writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
  console.log(
    `timeline: ${startFrame} frames (${(startFrame / FPS).toFixed(2)}s) -> ` +
      path.relative(VIDEO_ROOT, timelinePath),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
