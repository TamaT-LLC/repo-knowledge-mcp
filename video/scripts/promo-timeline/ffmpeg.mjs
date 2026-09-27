// Thin ffmpeg/ffprobe process wrappers used by the rest of the pipeline.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export async function ffmpeg(args) {
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-y", ...args],
    { maxBuffer: MAX_BUFFER_BYTES },
  );
  return stderr;
}

export async function probeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not read duration: ${file}`);
  }
  return duration;
}

export async function detectSilences(file, { noiseDb, minSilence }, duration) {
  const stderr = await ffmpeg([
    "-i",
    file,
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    "-f",
    "null",
    "-",
  ]);
  const silences = [];
  let openStart = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start: (-?[\d.]+)/);
    if (start) {
      openStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = line.match(/silence_end: ([\d.]+)/);
    if (end && openStart !== null) {
      silences.push({ start: openStart, end: Number(end[1]) });
      openStart = null;
    }
  }
  if (openStart !== null) silences.push({ start: openStart, end: duration });
  return silences;
}

export async function measureTruePeak(file) {
  const stderr = await ffmpeg([
    "-i",
    file,
    "-af",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const match = stderr.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)/);
  if (!match) throw new Error(`Could not measure true peak: ${file}`);
  return match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
}
