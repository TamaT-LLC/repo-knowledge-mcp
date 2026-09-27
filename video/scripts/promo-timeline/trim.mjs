// Edge trim: speech ends where the level stays under noiseDb for minSilence.
// Edge blips shorter than minEdgeSegment (clicks after the last word) are
// dropped, and so are short detached bursts (TTS artifacts) that sit behind a
// long silence. Speech that runs into the file end is reported as a probable
// cut-off ending (Seed Audio sometimes truncates the last mora).
export const TRIM = {
  noiseDb: -50,
  minSilence: 0.05,
  minEdgeSegment: 0.06,
  maxDetachedSegment: 0.2,
  minDetachGap: 0.3,
  endTolerance: 0.01,
  prePad: 0.03,
  postPad: 0.08,
  fadeIn: 0.01,
  fadeOut: 0.05,
};

export function speechBounds(silences, duration) {
  const segments = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor) {
      segments.push({ start: cursor, end: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration });
  if (segments.length === 0) throw new Error("No speech detected");
  const length = (segment) => segment.end - segment.start;
  const gap = (a, b) => Math.max(b.start - a.end, a.start - b.end);
  const isEdgeNoise = (segment, neighbor) =>
    length(segment) < TRIM.minEdgeSegment ||
    (length(segment) < TRIM.maxDetachedSegment &&
      gap(segment, neighbor) >= TRIM.minDetachGap);
  const dropped = [];
  while (segments.length > 1 && isEdgeNoise(segments[0], segments[1])) {
    dropped.push(segments.shift());
  }
  while (segments.length > 1 && isEdgeNoise(segments.at(-1), segments.at(-2))) {
    dropped.push(segments.pop());
  }
  return {
    start: segments[0].start,
    end: segments.at(-1).end,
    dropped,
    hasCutOffEnding: segments.at(-1).end >= duration - TRIM.endTolerance,
  };
}

export function trimFilter(bounds, duration) {
  const start = Math.max(0, bounds.start - TRIM.prePad);
  const end = Math.min(duration, bounds.end + TRIM.postPad);
  const fadeOutStart = end - start - TRIM.fadeOut;
  return [
    `atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)}`,
    "asetpts=PTS-STARTPTS",
    `afade=t=in:d=${TRIM.fadeIn}`,
    `afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${TRIM.fadeOut}`,
  ].join(",");
}
