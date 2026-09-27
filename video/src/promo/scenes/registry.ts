import { PlaceholderScene } from "./PlaceholderScene";
import { S01Hook } from "./S01Hook";
import { S02Product } from "./S02Product";
import { S03Local } from "./S03Local";
import { S04Optin } from "./S04Optin";
import { S05Approval } from "./S05Approval";
import { S06Rules } from "./S06Rules";
import { S07Agents } from "./S07Agents";
import { S08Cta } from "./S08Cta";
import type { SceneComponent } from "./types";

/** Scene id (timeline.json) → component. Each scene lives in its own file. */
export const SCENE_COMPONENTS: Readonly<Record<string, SceneComponent>> = {
  "s01-hook": S01Hook,
  "s02-product": S02Product,
  "s03-local": S03Local,
  "s04-optin": S04Optin,
  "s05-approval": S05Approval,
  "s06-rules": S06Rules,
  "s07-agents": S07Agents,
  "s08-cta": S08Cta,
};

export function sceneComponentOf(sceneId: string): SceneComponent {
  return SCENE_COMPONENTS[sceneId] ?? PlaceholderScene;
}
