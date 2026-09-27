"""Loudness mastering, AAC encoding and the script's `main()` entry point.

Outputs, both exactly as long as the video:
  public/audio/promo/bgm.m4a  quiet 96 BPM ambient / minimal electro in E major
  public/audio/promo/sfx.m4a  camera-arrival ticks, the s04 toggle click and
                              the s05 approval "stamp"

Mix levels (ducking, SFX gain) live in src/promo/theme.ts and
src/promo/audio/levels.ts. This module only masters each file.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import numpy as np

from .constants import (
    AAC_BITRATE,
    BGM_LIMIT_DBFS,
    BGM_PATH,
    BGM_SEED,
    BGM_TARGET_LUFS,
    BPM,
    OUTPUT_DIR,
    RATE,
    ROOT,
    SFX_PATH,
    SFX_PEAK_DBFS,
    SFX_SEED,
)
from .music import render_bgm
from .sfx import render_sfx
from .timeline import duration_of, load_timeline

# ---------------------------------------------------------------------------
# Mastering and encoding
# ---------------------------------------------------------------------------

RAW_INPUT = ["-f", "f32le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0"]


def to_pcm(audio: np.ndarray) -> bytes:
    return np.ascontiguousarray(audio, dtype="<f4").tobytes()


def summary_value(summary: str, pattern: str, what: str) -> float:
    match = re.search(pattern, summary)
    if match is None:
        raise RuntimeError(f"ffmpeg ebur128 summary has no {what}:\n{summary}")
    return float(match.group(1))


def measure(
    input_args: list[str], pcm: bytes | None = None
) -> tuple[float, float]:
    """Integrated loudness (LUFS) and true peak (dBTP) via ebur128."""
    command = ["ffmpeg", "-hide_banner", "-nostats", *input_args,
               "-af", "ebur128=peak=true", "-f", "null", "-"]
    result = subprocess.run(command, input=pcm, capture_output=True,
                            check=True)
    summary = result.stderr.decode()
    summary = summary[summary.rfind("Summary:"):]
    loudness = summary_value(summary, r"I:\s+(-?[\d.]+) LUFS", "loudness")
    peak = summary_value(summary, r"Peak:\s+(-?[\d.]+|-inf) dBFS", "peak")
    return loudness, peak


def encode(pcm: bytes, path: Path, filters: str | None = None) -> None:
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
               *RAW_INPUT]
    if filters:
        command += ["-af", filters]
    command += ["-c:a", "aac", "-b:a", AAC_BITRATE, "-ar", str(RATE),
                "-ac", "2", str(path)]
    subprocess.run(command, input=pcm, check=True)


def master_bgm(mix: np.ndarray, path: Path) -> None:
    pcm = to_pcm(mix)
    loudness, _ = measure(RAW_INPUT, pcm)
    gain_db = BGM_TARGET_LUFS - loudness
    ceiling = 10 ** (BGM_LIMIT_DBFS / 20)
    encode(pcm, path, f"volume={gain_db:.2f}dB,alimiter=limit={ceiling:.4f}"
                      ":attack=5:release=80:level=disabled")


def master_sfx(track: np.ndarray, path: Path) -> None:
    peak = 10 ** (SFX_PEAK_DBFS / 20)
    encode(to_pcm(track * (peak / np.max(np.abs(track)))), path)


def report(path: Path) -> None:
    loudness, peak = measure(["-i", str(path)])
    print(f"{path.relative_to(ROOT)}: {loudness:.1f} LUFS, {peak:.1f} dBTP")


def main() -> None:
    timeline = load_timeline()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{duration_of(timeline):.3f}s at {BPM} BPM")
    master_bgm(render_bgm(timeline, np.random.default_rng(BGM_SEED)), BGM_PATH)
    master_sfx(render_sfx(timeline, np.random.default_rng(SFX_SEED)), SFX_PATH)
    report(BGM_PATH)
    report(SFX_PATH)
