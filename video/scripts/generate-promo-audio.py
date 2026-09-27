#!/usr/bin/env python3
"""Generate the promo video's original BGM and SFX tracks.

src/promo/timeline.json is the timing source of truth: every section change,
transition swell and sound effect below is computed from it, so re-running
this script after the narration pipeline rewrites the timeline keeps the audio
in sync. Everything is synthesised with NumPy (no samples, no third-party
music) and encoded to 48 kHz stereo AAC with FFmpeg.

Outputs, both exactly as long as the video:
  public/audio/promo/bgm.m4a  quiet 96 BPM ambient / minimal electro in E major
  public/audio/promo/sfx.m4a  camera-arrival ticks, the s04 toggle click and
                              the s05 approval "stamp"

Mix levels (ducking, SFX gain) live in src/promo/theme.ts and
src/promo/audio/levels.ts. This script only masters each file.

The implementation lives in scripts/promo_audio/ (timeline frame math, DSP,
the BGM arrangement, the SFX track and mastering); this file is the entry
point kept at its historical path so `npm run audio:promo` keeps working.

Usage: python3 scripts/generate-promo-audio.py  (requires numpy and ffmpeg)
"""

from __future__ import annotations

try:
    from promo_audio.mix import main
except ModuleNotFoundError as error:
    if error.name != "numpy":
        raise
    raise SystemExit(
        "generate-promo-audio.py needs numpy (python3 -m pip install numpy) "
        "and ffmpeg on PATH."
    ) from error

if __name__ == "__main__":
    main()
