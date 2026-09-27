"""The SFX track: camera-arrival ticks, the s04 toggle click and the s05
approval "stamp". render_sfx() is the entry point used by mix.py.
"""

from __future__ import annotations

import numpy as np

from .constants import RATE
from .synth import (
    attack,
    band_noise,
    convolve,
    panned,
    place,
    reverb_ir,
    samples,
    sine,
    taper,
    time_axis,
)
from .timeline import approve_time, arrival_times, duration_of, toggle_time

# ---------------------------------------------------------------------------
# Sound effects
# ---------------------------------------------------------------------------

# Peak of each sound relative to the stamp (each clip is peak-normalised).
TICK_GAIN = 0.5
TOGGLE_GAIN = 0.6
STAMP_GAIN = 1.0
ROOM_WET = 0.12


def click(
    rng: np.random.Generator, t: np.ndarray, at: float, tone_hz: float,
    band: tuple[float, float], tau: float,
) -> np.ndarray:
    """A tiny transient: band-limited noise plus a pitched body."""
    local = np.maximum(t - at, 0.0)
    env = attack(local, 0.0005) * np.exp(-local / tau) * (t >= at)
    noise = band_noise(rng, len(t), band)
    noise /= np.max(np.abs(noise))
    return (0.8 * noise + 0.5 * sine(tone_hz, local)) * env


def tick(rng: np.random.Generator) -> np.ndarray:
    """The camera-arrival 「チッ」."""
    t = time_axis(0.05)
    return panned(click(rng, t, 0.0, 3100, (3000, 9000), 0.006))


def toggle_click(rng: np.random.Generator) -> np.ndarray:
    """Press, then latch: a small two-part switch 「カチッ」."""
    t = time_axis(0.08)
    press = click(rng, t, 0.0, 1800, (1500, 5000), 0.005)
    latch = click(rng, t, 0.016, 3400, (3000, 9000), 0.004)
    return panned(press + 0.8 * latch)


def stamp(rng: np.random.Generator) -> np.ndarray:
    """A short, soft hanko 「トン」: a woody thump with a little felt."""
    t = time_axis(0.45)
    pitch = 150 + 60 * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(pitch) / RATE) * np.exp(-t / 0.09)
    knock = 0.35 * sine(520, t) * np.exp(-t / 0.025)
    felt = band_noise(rng, len(t), (200, 1600))
    felt = 0.5 * felt / np.max(np.abs(felt)) * np.exp(-t / 0.012)
    mono = (body + knock + felt) * attack(t, 0.002) * taper(t, 0.05)
    return panned(mono)


def sfx_cues(timeline: dict) -> list[tuple[str, float]]:
    cues = [("tick", time) for time in arrival_times(timeline)]
    cues.append(("toggle", toggle_time(timeline)))
    cues.append(("stamp", approve_time(timeline)))
    return sorted(cues, key=lambda cue: cue[1])


def normalized(clip: np.ndarray) -> np.ndarray:
    return clip / np.max(np.abs(clip))


def render_sfx(timeline: dict, rng: np.random.Generator) -> np.ndarray:
    # Each sound is made once, so every arrival tick is the same UI sound.
    sounds = {
        "tick": normalized(tick(rng)) * TICK_GAIN,
        "toggle": normalized(toggle_click(rng)) * TOGGLE_GAIN,
        "stamp": normalized(stamp(rng)) * STAMP_GAIN,
    }
    track = np.zeros((samples(duration_of(timeline)), 2))
    for name, time in sfx_cues(timeline):
        place(track, sounds[name], time, 1.0)
        print(f"  sfx {name:<6} frame {time * timeline['fps']:7.1f}")
    room = convolve(track, reverb_ir(rng, 0.35, 0.008, 7000))
    return track + ROOM_WET * room
