// Renders review stills of the narrated promo for both orientations.
//
//   npm run stills:promo                       # mid-scene still of every scene
//   npm run stills:promo -- --only=s01-hook    # comma-separated scene ids
//   npm run stills:promo -- --boundaries       # also each camera move midpoint
//
// Frames are derived from src/promo/timeline.json, never hard-coded.
import { mkdir, readFile } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const OUT_DIR = "out/stills-promo";
/** "Mid-scene": late enough that most cues of the scene have entered. */
const MID_SCENE_RATIO = 0.6;
const COMPOSITIONS = [
  { id: "RepoKnowledgePromo", prefix: "landscape" },
  { id: "RepoKnowledgePromoVertical", prefix: "portrait" },
];

const args = process.argv.slice(2);
const onlyArg = args.find((arg) => arg.startsWith("--only="));
const only = onlyArg
  ? new Set(onlyArg.slice("--only=".length).split(","))
  : null;
const withBoundaries = args.includes("--boundaries");

const timeline = JSON.parse(await readFile("src/promo/timeline.json", "utf8"));
const scenes = timeline.scenes.filter((scene) => !only || only.has(scene.id));
if (scenes.length === 0) throw new Error("No scene matched --only");

const targets = scenes.flatMap((scene) => {
  const mid = {
    name: `${scene.id}-mid`,
    frame:
      scene.startFrame + Math.floor(scene.durationFrames * MID_SCENE_RATIO),
  };
  const boundary = {
    name: `${scene.id}-arrive`,
    frame: scene.startFrame,
  };
  return withBoundaries && scene.startFrame > 0 ? [boundary, mid] : [mid];
});

const serveUrl = await bundle({ entryPoint: "src/index.ts" });
await mkdir(OUT_DIR, { recursive: true });
for (const { id, prefix } of COMPOSITIONS) {
  const composition = await selectComposition({ serveUrl, id });
  for (const target of targets) {
    const output = `${OUT_DIR}/${prefix}-${target.name}-f${target.frame}.png`;
    await renderStill({
      serveUrl,
      composition,
      frame: target.frame,
      output,
      imageFormat: "png",
    });
    process.stdout.write(`Rendered ${output}\n`);
  }
}
