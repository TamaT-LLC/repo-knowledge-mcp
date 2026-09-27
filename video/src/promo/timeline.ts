import timelineJson from "./timeline.json";

// timeline.json is the single source of truth for timing. It is rewritten by
// the narration pipeline, so nothing in the video may hard-code scene lengths,
// caption times or cue frames. All frames inside a scene are relative to the
// scene's startFrame.

export type TimelineCaption = {
  readonly text: string;
  readonly startFrame: number;
  readonly endFrame: number;
};

export type TimelineNarration = {
  /** Path relative to public/, for staticFile(). */
  readonly file: string;
  readonly startFrame: number;
  readonly durationFrames: number;
};

export type TimelineScene = {
  readonly id: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly narration: TimelineNarration;
  readonly captions: readonly TimelineCaption[];
  readonly captionTiming: string;
};

export type Timeline = {
  readonly fps: number;
  readonly totalFrames: number;
  readonly scenes: readonly TimelineScene[];
};

/** Caption chunk name used by the storyboard: "c1" is captions[0]. */
export type CueName = `c${number}`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(record: JsonRecord, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`timeline.json: ${where}.${key} must be a number`);
  }
  return value;
}

function readString(record: JsonRecord, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`timeline.json: ${where}.${key} must be a string`);
  }
  return value;
}

function readRecord(record: JsonRecord, key: string, where: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`timeline.json: ${where}.${key} must be an object`);
  }
  return value;
}

function parseCaption(value: unknown, where: string): TimelineCaption {
  if (!isRecord(value)) throw new Error(`timeline.json: ${where} is invalid`);
  return {
    text: readString(value, "text", where),
    startFrame: readNumber(value, "startFrame", where),
    endFrame: readNumber(value, "endFrame", where),
  };
}

function parseScene(value: unknown, index: number): TimelineScene {
  const where = `scenes[${index}]`;
  if (!isRecord(value)) throw new Error(`timeline.json: ${where} is invalid`);
  const narration = readRecord(value, "narration", where);
  const captions = value.captions;
  if (!Array.isArray(captions)) {
    throw new Error(`timeline.json: ${where}.captions must be an array`);
  }
  return {
    id: readString(value, "id", where),
    startFrame: readNumber(value, "startFrame", where),
    durationFrames: readNumber(value, "durationFrames", where),
    narration: {
      file: readString(narration, "file", `${where}.narration`),
      startFrame: readNumber(narration, "startFrame", `${where}.narration`),
      durationFrames: readNumber(
        narration,
        "durationFrames",
        `${where}.narration`,
      ),
    },
    captions: captions.map((caption, i) =>
      parseCaption(caption, `${where}.captions[${i}]`),
    ),
    captionTiming:
      typeof value.captionTiming === "string" ? value.captionTiming : "",
  };
}

/** Validates the untyped JSON so a malformed file fails loudly at load. */
export function parseTimeline(value: unknown): Timeline {
  if (!isRecord(value)) throw new Error("timeline.json must be an object");
  const scenes = value.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("timeline.json: scenes must be a non-empty array");
  }
  return {
    fps: readNumber(value, "fps", "root"),
    totalFrames: readNumber(value, "totalFrames", "root"),
    scenes: scenes.map(parseScene),
  };
}

export const TIMELINE: Timeline = parseTimeline(timelineJson);

function captionIndexOf(cue: CueName): number {
  const position = Number.parseInt(cue.slice(1), 10);
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(`Invalid cue "${cue}". Use c1, c2, c3 ...`);
  }
  return position - 1;
}

export function getCaption(
  scene: TimelineScene,
  cue: CueName,
): TimelineCaption {
  const caption = scene.captions[captionIndexOf(cue)];
  if (!caption) {
    throw new Error(
      `${scene.id} has ${scene.captions.length} caption chunks; "${cue}" does not exist`,
    );
  }
  return caption;
}

/** Scene-relative start frame of a caption chunk, plus an optional offset. */
export function cueFrame(
  scene: TimelineScene,
  cue: CueName,
  offsetFrames = 0,
): number {
  return getCaption(scene, cue).startFrame + offsetFrames;
}

/** Scene-relative end frame of a caption chunk, plus an optional offset. */
export function cueEndFrame(
  scene: TimelineScene,
  cue: CueName,
  offsetFrames = 0,
): number {
  return getCaption(scene, cue).endFrame + offsetFrames;
}

const countSpokenChars = (text: string): number =>
  Array.from(text.replace(/\s/g, "")).length;

/**
 * Scene-relative frame at which `phrase` is (approximately) spoken, by
 * interpolating its character position inside the caption chunk that
 * contains it. Used for storyboard cues such as "c2の『許可した』付近".
 */
export function phraseFrame(
  scene: TimelineScene,
  phrase: string,
  offsetFrames = 0,
): number {
  const caption = scene.captions.find((c) => c.text.includes(phrase));
  if (!caption) {
    throw new Error(`${scene.id}: no caption contains "${phrase}"`);
  }
  const before = countSpokenChars(
    caption.text.slice(0, caption.text.indexOf(phrase)),
  );
  const ratio = before / Math.max(1, countSpokenChars(caption.text));
  const span = caption.endFrame - caption.startFrame;
  return Math.round(caption.startFrame + ratio * span) + offsetFrames;
}

export function secondsToFrames(seconds: number): number {
  return Math.round(seconds * TIMELINE.fps);
}
