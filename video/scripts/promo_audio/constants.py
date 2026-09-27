"""Paths, mirrored TS constants, mix numbers and the chord/section tables.

Pure data: nothing here reads timeline.json or does DSP. See timeline.py for
the frame math that turns these tables into a schedule of Segments.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TIMELINE_PATH = ROOT / "src" / "promo" / "timeline.json"
OUTPUT_DIR = ROOT / "public" / "audio" / "promo"
BGM_PATH = OUTPUT_DIR / "bgm.m4a"
SFX_PATH = OUTPUT_DIR / "sfx.m4a"

RATE = 48_000
AAC_BITRATE = "192k"
BGM_SEED = 1621
SFX_SEED = 1622

# Mirrors of the video's motion constants. Keep in sync with the TS source.
# These are not just timing offsets: s04's toggle press and s05's approve
# stamp are re-derived with the *same formulas* as the TSX scenes (below),
# using phraseFrame()/cueFrame() from src/promo/timeline.ts, so the sound
# tracks the actual video beat even after the narration pipeline reflows
# timeline.json.
CAMERA_HALF_FRAMES = 9  # theme.ts CAMERA_FRAMES / 2: moves span start ± 9
CARET_BLINK_FRAMES = 16  # theme.ts CARET_BLINK_FRAMES: the caret toggles every 16 frames
ENTER_FRAMES = 16  # theme.ts ENTER_FRAMES: standard wipe-in length
STAGGER_FRAMES = 3  # theme.ts STAGGER_FRAMES: delay between siblings entering in turn
OVERVIEW_SCENE_ID = "s07-agents"  # camera.ts OVERVIEW_SCENE_ID
OVERVIEW_CUE = 3  # camera.ts OVERVIEW_CUE ("c3")
OVERVIEW_MORPH_FRAMES = 24  # theme.ts OVERVIEW_MORPH_FRAMES

# src/promo/scenes/S04Optin.tsx optinCues(): the toggle press (`clickAt`,
# passed to OptinList as `onAt`, where the toggle starts turning vermilion).
TOGGLE_SCENE_ID = "s04-optin"
TOGGLE_CUE = 2  # c2「明示的に許可した方法だけ。」: the pointer waits for this cue
PERMIT_PHRASE = "許可した"  # S04Optin.tsx PERMIT_PHRASE: onset of the press
METHODS_COUNT = 3  # S04Optin.tsx METHODS.length
POINTER_APPEAR_FRAMES = 6  # components/ClickPointer.tsx POINTER_APPEAR_FRAMES
MIN_POINTER_TRAVEL_FRAMES = 10  # S04Optin.tsx MIN_POINTER_TRAVEL_FRAMES

# src/promo/scenes/S05Approval.tsx approvalCues(): approve confirmed
# (`confirmAt`), the stamp beat (approve turns vermilion, StampRing fires).
APPROVE_SCENE_ID = "s05-approval"
APPROVE_CUE = 3  # c3「承認した候補だけ。」: the cursor lands on approve here
EVIDENCE_PHRASE = "根拠"  # S05Approval.tsx EVIDENCE_PHRASE
TTY_AFTER_ARRIVAL_FRAMES = 6  # S05Approval.tsx TTY_AFTER_ARRIVAL_FRAMES
CURSOR_TO_CONFIRM_FRAMES = 8  # S05Approval.tsx CURSOR_TO_CONFIRM_FRAMES
TYPE_PAUSE_FRAMES = 2 * STAGGER_FRAMES  # S05Approval.tsx TYPE_PAUSE_FRAMES
REVIEW_COMMAND = "repo-knowledge review"  # components/ReviewTty.tsx REVIEW_COMMAND
REVIEW_TARGET = "owner/repository"  # components/ReviewTty.tsx REVIEW_TARGET

# Caret pulses follow the caret blink in these scenes, from this frame on.
CARET_SCENES = {"s01-hook": 0, "s08-cta": CAMERA_HALF_FRAMES}

# Mastering.
BGM_TARGET_LUFS = -13.0  # with theme.ts ducking: ~17 LU under the voice
BGM_LIMIT_DBFS = -2.0
SFX_PEAK_DBFS = -6.0
INTRO_FADE_S = 1.2
OUTRO_FADE_S = 2.5

# Tempo and grid. The groove's downbeat lands on the s02 camera arrival.
BPM = 96
BEAT_S = 60 / BPM
SIXTEENTH_S = BEAT_S / 4
STEPS_PER_BEAT = 4
KICK_EVERY_BEATS = 2  # half-time keeps 96 BPM calm under the voice
HAT_ACCENTS = (0.3, 0.1, 0.7, 0.15)  # per 16th inside a beat
# Arp: one bar of 16ths; numbers index the chord's arp notes, None rests.
ARP_PATTERN = (0, None, 2, None, None, 1, None, 3,
               None, 2, None, None, 1, None, 3, None)
ARP_TRANSPOSE = 36  # pad voicing + 3 octaves: 1.6–3 kHz, quiet and short
ARP_ECHO_STEPS = 3  # dotted-8th echo, opposite side
ARP_ECHO_GAIN = 0.35

# Layer gains (relative; the file is loudness-normalised afterwards) and
# reverb sends.
PAD_GAIN, PAD_SEND = 0.05, 0.3
SUB_GAIN = 0.13
BASS_GAIN, BASS_SEND = 0.2, 0.05
KICK_GAIN = 0.25
HAT_GAIN, HAT_SEND = 0.03, 0.15
ARP_GAIN, ARP_SEND = 0.035, 0.7
AIR_PARTIAL_GAIN, AIR_NOISE_GAIN, AIR_SEND = 0.016, 0.012, 0.6
SPARKLE_GAIN, SPARKLE_SEND, SPARKLE_MAX_RATE = 0.035, 0.9, 4.0
CARET_PING_GAIN, CARET_THUMP_GAIN, CARET_SEND = 0.04, 0.12, 0.4
CHIME_GAIN, CHIME_SEND = 0.03, 0.8
SWELL_GAIN, SWELL_SEND = 0.05, 0.5
REVERB_RETURN = 0.55

# Tone shaping: keep 300 Hz–3 kHz (the voice) uncluttered.
PAD_HIGHPASS_HZ = 110
PAD_DARK_HZ = 420
PAD_BRIGHT_HZ = 1300
SUB_HIGHPASS_HZ = 28
SUB_LOWPASS_HZ = 160
AIR_NOISE_BAND_HZ = (7000, 14000)
HAT_BAND_HZ = (7500, 15000)
REVERB_BAND_HZ = (220, 7000)
PUMP_DEPTH = 0.3  # pad/sub dip on each kick (sidechain feel)
PUMP_RELEASE_S = 0.16
PUMP_TAIL_TAUS = 8  # dip lasts until it is inaudible (< 0.01 %)

# Transition swells (filtered noise). The peak lands on the camera arrival.
SWELL_HIGHPASS_HZ = 180
STFT_SIZE = 2048
STFT_HOP = STFT_SIZE // 4
HANN_SQUARED_OVERLAP = 1.5  # sum of hann² windows at a quarter hop


@dataclass(frozen=True)
class Chord:
    bass: tuple[int, ...]  # sub MIDI notes; the last also drives the pluck
    pad: tuple[int, ...]  # 165–370 Hz fundamentals, low-passed
    air: tuple[int, ...]  # shimmer partials, all near/above 2 kHz
    ping: int  # caret pulse note


@dataclass(frozen=True)
class Section:
    """Layer levels (0–1; sparkle is grains per second) for one stretch."""

    pad_open: float  # pad low-pass: 0 = dark, 1 = brighter (< 1.3 kHz)
    width: float  # stereo side gain of pad and air
    sub: float
    air: float
    sparkle: float
    caret: float  # caret-synced pulse (s01 / s08)
    bass_on: float  # bass pluck on the beat
    bass_off: float  # bass pluck on the off-beat 8th
    kick: float
    hats: float
    arp: float


@dataclass(frozen=True)
class Segment:
    """A chord + section that crossfades in over [start, end] seconds."""

    start: float
    end: float
    chord: Chord
    section: Section


@dataclass(frozen=True)
class Swell:
    rise_s: float
    fall_s: float
    start_hz: float
    peak_hz: float
    end_hz: float
    gain: float


# E major. vi → IV → I/3 → ii → Vsus → V → vi (deceptive) → IV(#11) → I.
CHORDS = {
    "C#m9": Chord((37,), (52, 56, 59, 63), (99, 104, 107), 80),
    "Amaj9": Chord((33,), (52, 56, 59, 61), (95, 100, 104), 88),
    "Emaj9/G#": Chord((32,), (56, 59, 63, 66), (99, 102, 107), 83),
    "F#m11": Chord((30,), (57, 59, 61, 64), (97, 100, 107), 85),
    "Bsus4": Chord((35,), (54, 59, 61, 64), (97, 100, 102), 90),
    "Badd9": Chord((35,), (54, 59, 61, 63), (97, 99, 102), 90),
    "Amaj9#11": Chord((33,), (52, 56, 59, 61), (97, 99, 104, 107), 88),
    "Emaj9": Chord((28, 40), (56, 59, 63, 66), (99, 102, 104, 107), 83),
}
SCENE_CHORDS = {
    "s01-hook": "C#m9",
    "s02-product": "Amaj9",
    "s03-local": "Emaj9/G#",
    "s04-optin": "F#m11",
    "s05-approval": "Bsus4",
    "s06-rules": "C#m9",
    "s07-agents": "Amaj9",
    "s08-cta": "Emaj9",
}
APPROVE_CHORD = "Badd9"  # the sus4 resolves on the stamp
OVERVIEW_CHORD = "Amaj9#11"
APPROVE_CROSSFADE_S = 0.25

S = Section
SECTIONS = {
    # pad_open width sub air sparkle caret bass_on bass_off kick hats arp
    "s01-hook": S(0.0, 0.6, 0.6, 0.5, 0.3, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0),
    "s02-product": S(0.35, 0.9, 0.8, 0.7, 0.8, 0.0, 0.55, 0.0, 0.0, 0.0, 0.3),
    "s03-local": S(0.45, 0.9, 1.0, 0.6, 0.6, 0.0, 0.8, 0.55, 0.0, 0.5, 0.35),
    "s04-optin": S(0.5, 0.9, 1.0, 0.6, 0.6, 0.0, 0.9, 0.6, 0.6, 0.7, 0.45),
    "s05-approval": S(0.55, 1.0, 1.0, 0.65, 0.7, 0.0, 1.0, 0.65, 0.8, 0.8, 0.6),
    "s06-rules": S(0.65, 1.0, 1.0, 0.7, 0.8, 0.0, 1.0, 0.7, 1.0, 1.0, 0.8),
    "s07-agents": S(0.65, 1.0, 1.0, 0.7, 0.8, 0.0, 1.0, 0.7, 1.0, 1.0, 0.8),
    "overview": S(1.0, 1.6, 0.9, 1.0, 2.5, 0.0, 0.7, 0.0, 0.0, 0.35, 1.0),
    "s08-cta": S(0.4, 1.2, 0.8, 0.8, 1.0, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0),
}
TRANSITION_SWELL = Swell(0.85, 0.45, 350, 4500, 1500, 1.0)
OVERVIEW_SWELL = Swell(0.9, 1.3, 300, 7000, 2500, 1.4)
