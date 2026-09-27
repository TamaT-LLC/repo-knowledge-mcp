import { mkdir, readFile } from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const edition = process.argv[2] ?? "original";
const editions = JSON.parse(await readFile("src/editions.json", "utf8"));
if (!(edition in editions)) throw new Error(`Unknown edition: ${edition}`);
const out = edition === "quick" ? "out/stills-quick" : "out/stills";
const serveUrl = await bundle({ entryPoint: "src/index.ts" });
const composition = await selectComposition({
  serveUrl,
  id: edition === "quick" ? "RepoKnowledgeIntroQuick" : "RepoKnowledgeIntro",
});
await mkdir(out, { recursive: true });
const durations = editions[edition].frames;
const frames = durations.map(
  (duration, i) =>
    durations.slice(0, i).reduce((sum, n) => sum + n, 0) +
    Math.floor(duration * 0.8),
);
for (const frame of frames) {
  await renderStill({
    serveUrl,
    composition,
    frame,
    output: `${out}/${frame}.png`,
    imageFormat: "png",
  });
  process.stdout.write(`Rendered frame ${frame}\n`);
}
