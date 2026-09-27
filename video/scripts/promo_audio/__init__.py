"""BGM/SFX synthesis for the promo video (see scripts/generate-promo-audio.py).

Modules:
  constants  paths, mirrored TS motion constants, mastering/tempo/mix numbers,
             the Chord/Section/Segment/Swell data and the chord/section tables
  timeline   timeline.json loading, frame math (mirrors src/promo/timeline.ts)
             and the Segment schedule (src/promo/scenes/S04Optin.tsx,
             S05Approval.tsx) that both bgm and sfx read from
  synth      oscillators, filters and one-shot instruments (pure NumPy DSP)
  music      the BGM arrangement (pad/sub/air/drums/arp/cues -> render_bgm)
  sfx        the SFX track (tick/toggle/stamp -> render_sfx)
  mix        loudness mastering, AAC encoding and the `main()` entry point
"""

from __future__ import annotations
