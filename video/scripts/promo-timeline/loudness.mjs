// Two-pass EBU R128 loudness normalization to m4a, with a true-peak fix-up
// loop: AAC can overshoot loudnorm's true peak, so the encoded file is
// measured and re-encoded with the excess taken off as plain gain.
import { AAC_BITRATE, SAMPLE_RATE } from "./constants.mjs";
import { ffmpeg, measureTruePeak } from "./ffmpeg.mjs";

export const LOUDNESS = { integrated: -16, truePeak: -1.5, range: 11 };
const MAX_PEAK_FIXES = 2;
const PEAK_FIX_MARGIN_DB = 0.1;

function parseLoudnormJson(stderr) {
  const blocks = stderr.match(/\{[^{}]*\}/g);
  if (!blocks) throw new Error("loudnorm did not print measurements");
  return JSON.parse(blocks.at(-1));
}

function encodeM4a(rawPath, filter, gainDb, outPath) {
  const gain = gainDb === 0 ? "" : `,volume=${gainDb.toFixed(2)}dB`;
  return ffmpeg([
    "-i",
    rawPath,
    "-af",
    `${filter}${gain},aresample=${SAMPLE_RATE}`,
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "aac",
    "-b:a",
    AAC_BITRATE,
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-movflags",
    "+faststart",
    outPath,
  ]);
}

export async function normalizeToM4a(rawPath, trim, outPath) {
  const target = `loudnorm=I=${LOUDNESS.integrated}:TP=${LOUDNESS.truePeak}:LRA=${LOUDNESS.range}`;
  const firstPass = parseLoudnormJson(
    await ffmpeg([
      "-i",
      rawPath,
      "-af",
      `${trim},${target}:print_format=json`,
      "-f",
      "null",
      "-",
    ]),
  );
  if (!Number.isFinite(Number(firstPass.input_i))) {
    throw new Error(`Silent input: ${rawPath}`);
  }
  const measured = [
    `measured_I=${firstPass.input_i}`,
    `measured_TP=${firstPass.input_tp}`,
    `measured_LRA=${firstPass.input_lra}`,
    `measured_thresh=${firstPass.input_thresh}`,
    `offset=${firstPass.target_offset}`,
  ].join(":");
  const secondPassFilter = `${trim},${target}:${measured}:linear=true:print_format=json`;
  let gainDb = 0;
  for (let attempt = 0; attempt <= MAX_PEAK_FIXES; attempt += 1) {
    const secondPass = parseLoudnormJson(
      await encodeM4a(rawPath, secondPassFilter, gainDb, outPath),
    );
    const truePeak = await measureTruePeak(outPath);
    const excess = truePeak - LOUDNESS.truePeak;
    if (excess <= 0 || attempt === MAX_PEAK_FIXES) {
      return { ...secondPass, encoded_tp: truePeak, gain_db: gainDb };
    }
    gainDb -= excess + PEAK_FIX_MARGIN_DB;
  }
  throw new Error("unreachable");
}
