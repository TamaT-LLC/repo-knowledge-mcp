// Splits each scene's narration into caption chunks and times them: pauses
// in the audio snap a boundary near the position predicted by reading
// length, and any boundary with no nearby pause falls back to that ratio.
import { FPS } from "./constants.mjs";

export const CAPTION_SILENCE = { noiseDb: -35, minSilence: 0.12 };
// A pause may define a caption boundary only near the position predicted by
// the reading-length ratio; longer pauses win ties.
const SNAP = { minTolerance: 0.5, toleranceRatio: 0.15, longPauseBonus: 0.5 };
const CAPTION_PUNCTUATION = /[、。！？]/;
const SMALL_KANA = new Set([..."ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ"]);
const KANJI_WEIGHT = 2;

function readingWeight(text) {
  let weight = 0;
  for (const char of text) {
    if (SMALL_KANA.has(char)) continue;
    if (/\p{Script=Han}/u.test(char)) {
      weight += KANJI_WEIGHT;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(char)) weight += 1;
  }
  return weight;
}

const countPunctuation = (text) =>
  [...text].filter((char) => CAPTION_PUNCTUATION.test(char)).length;

// Splits ttsText into the same chunks as captions by counting 、。 so that the
// ratio fallback uses spoken length, not display text such as "gh CLI".
function readingChunks(ttsText, captions) {
  const counts = captions.map(countPunctuation);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.includes(0) || total !== countPunctuation(ttsText)) {
    return captions;
  }
  const chunks = [];
  let buffer = "";
  let seen = 0;
  for (const char of ttsText) {
    buffer += char;
    if (!CAPTION_PUNCTUATION.test(char)) continue;
    seen += 1;
    if (seen === counts[chunks.length]) {
      chunks.push(buffer);
      buffer = "";
      seen = 0;
    }
  }
  return chunks;
}

function bestSilence(candidates, expected, tolerance) {
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const silence of candidates) {
    const distance = Math.abs((silence.start + silence.end) / 2 - expected);
    if (distance > tolerance) continue;
    const score =
      distance - SNAP.longPauseBonus * (silence.end - silence.start);
    if (score < bestScore) {
      best = silence;
      bestScore = score;
    }
  }
  return best;
}

// Greedy pass: each boundary snaps to the best pause near the position
// predicted from the last anchor; unmatched boundaries stay null.
function snapBoundaries(cumulative, silences, speech) {
  const total = cumulative.at(-1);
  const tolerance = Math.max(
    SNAP.minTolerance,
    (speech.end - speech.start) * SNAP.toleranceRatio,
  );
  const boundaries = [];
  let anchor = { time: speech.start, weight: 0 };
  for (let k = 1; k < cumulative.length - 1; k += 1) {
    const share = (cumulative[k] - anchor.weight) / (total - anchor.weight);
    const expected = anchor.time + (speech.end - anchor.time) * share;
    const candidates = silences.filter((s) => s.start >= anchor.time);
    const pick = bestSilence(candidates, expected, tolerance);
    boundaries.push(
      pick ? { end: pick.start, start: pick.end, method: "silence" } : null,
    );
    if (pick) anchor = { time: pick.end, weight: cumulative[k] };
  }
  return boundaries;
}

// Unmatched boundaries are interpolated by reading length between anchors.
function fillRatioBoundaries(boundaries, cumulative, speech) {
  return boundaries.map((boundary, index) => {
    if (boundary) return boundary;
    let prev = index - 1;
    while (prev >= 0 && !boundaries[prev]) prev -= 1;
    let next = index + 1;
    while (next < boundaries.length && !boundaries[next]) next += 1;
    const from = prev >= 0 ? boundaries[prev].start : speech.start;
    const fromWeight = prev >= 0 ? cumulative[prev + 1] : 0;
    const hasNext = next < boundaries.length;
    const to = hasNext ? boundaries[next].end : speech.end;
    const toWeight = hasNext ? cumulative[next + 1] : cumulative.at(-1);
    const share =
      (cumulative[index + 1] - fromWeight) / (toWeight - fromWeight);
    const time = from + (to - from) * share;
    return { end: time, start: time, method: "ratio" };
  });
}

export function captionTiming(scene, silences, duration) {
  const weights = readingChunks(scene.ttsText, scene.captions).map((chunk) =>
    Math.max(1, readingWeight(chunk)),
  );
  const cumulative = [0];
  for (const weight of weights) cumulative.push(cumulative.at(-1) + weight);
  const speech = { start: 0, end: duration };
  const inner = silences.filter((s) => s.start > 0 && s.end < duration);
  const snapped = snapBoundaries(cumulative, inner, speech);
  const boundaries = fillRatioBoundaries(snapped, cumulative, speech);
  const isSilence =
    boundaries.length > 0 && boundaries.every((b) => b.method === "silence");
  return { boundaries, method: isSilence ? "silence" : "ratio" };
}

export function captionFrames(
  captions,
  boundaries,
  leadFrames,
  narrationFrames,
) {
  return captions.map((text, index) => {
    const isLast = index === captions.length - 1;
    const start =
      index === 0 ? 0 : Math.round(boundaries[index - 1].start * FPS);
    const end = isLast
      ? narrationFrames
      : Math.round(boundaries[index].end * FPS);
    return {
      text,
      startFrame: leadFrames + start,
      endFrame: leadFrames + Math.max(end, start + 1),
    };
  });
}
