// Filesystem paths for the build-promo-timeline pipeline. VIDEO_ROOT is
// resolved from this file's own location (scripts/promo-timeline/), one
// level deeper than the scripts/build-promo-timeline.mjs entry point.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const SCRIPT_PATH = path.join(VIDEO_ROOT, "src/promo/script.json");
export const TIMELINE_PATH = path.join(VIDEO_ROOT, "src/promo/timeline.json");
export const PUBLIC_DIR = path.join(VIDEO_ROOT, "public");
export const NARRATION_DIR = "audio/promo/narration";
