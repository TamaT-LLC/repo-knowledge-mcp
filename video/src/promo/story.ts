import script from "./script.json";

// On-screen strings that appear in more than one scene. Keep them here so the
// comment in s01, the diff morph in s04 and the rule rows in s06/s07 can never
// drift apart. Source: docs/promo-script.md (README v0.4.2 examples).

/** The hero: the one-line review comment the whole video follows. */
export const HERO_COMMENT =
  "GitHub API の応答は、保存する前に strict schema で検証し、未知 key を拒否してください。";

/** The head of the comment that the hero token carries along the thread. */
export const HERO_COMMENT_HEAD = "GitHub API の応答は";

/** Label of the hero token pill. */
export const HERO_TOKEN_LABEL = `${HERO_COMMENT_HEAD}…`;

/** The distilled rule (s04 result, s05 candidate, s06/s07 rule rows). */
export const HERO_RULE =
  "GitHub API の応答は、永続化する前に strict schema で検証する";

export const TOKEN_TAGS = {
  rawEvidence: "raw evidence",
  proposed: "proposed",
  active: "active",
} as const;

export const WORDMARK = "repo-knowledge-mcp";

/**
 * One station per scene, in timeline order. The label is drawn beside the
 * node on the thread (and listed in the s07 overview).
 */
export const STATION_LABELS: Readonly<Record<string, string>> = {
  "s01-hook": "PR",
  "s02-product": "repo-knowledge-mcp",
  "s03-local": "LOCAL",
  "s04-optin": "DISTILL",
  "s05-approval": "HUMAN REVIEW",
  "s06-rules": "get_rules",
  "s07-agents": "AGENTS",
  "s08-cta": "SETUP",
};

export function stationLabelOf(sceneId: string): string {
  return STATION_LABELS[sceneId] ?? sceneId;
}

export type ScriptScene = (typeof script.scenes)[number];

/** script.json entry (headline, narration, captions, visual) for a scene. */
export function getScriptScene(sceneId: string): ScriptScene {
  const entry = script.scenes.find((scene) => scene.id === sceneId);
  if (!entry) throw new Error(`script.json has no scene "${sceneId}"`);
  return entry;
}

export function headlineOf(sceneId: string): string {
  return getScriptScene(sceneId).headline;
}
