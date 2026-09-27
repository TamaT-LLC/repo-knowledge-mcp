"""Sustained voices (absolute-phase oscillators) and one-shot instruments,
built on the DSP primitives in synth.py. Used by music.py (BGM).
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from .constants import CARET_PING_GAIN, CARET_THUMP_GAIN, RATE, Chord, Segment, Swell
from .synth import attack, hz, panned, sine, swept_noise, taper, time_axis, total
from .timeline import segment_weight

# ---------------------------------------------------------------------------
# Voices (sustained, absolute-phase oscillators) and one-shot instruments
# ---------------------------------------------------------------------------

PAD_HARMONICS = ((1, 1.0), (2, 0.28), (3, 0.1), (4, 0.04))
PAD_DETUNE_CENTS = 7
PAD_DETUNED_GAIN = 0.7
PAD_DRIFT_DEPTH = 0.15


def harmonic_tone(freq: float, t: np.ndarray) -> np.ndarray:
    return total((gain * sine(freq * n, t, n) for n, gain in PAD_HARMONICS), t)


def pad_voice(note: int, t: np.ndarray) -> np.ndarray:
    freq = hz(note)
    detune = 2 ** (PAD_DETUNE_CENTS / 1200)
    centre = harmonic_tone(freq, t)
    left = centre + PAD_DETUNED_GAIN * harmonic_tone(freq / detune, t)
    right = centre + PAD_DETUNED_GAIN * harmonic_tone(freq * detune, t)
    drift = 1 + PAD_DRIFT_DEPTH * sine(0.06 + 0.013 * (note % 5), t, note)
    return np.stack([left, right], axis=1) * drift[:, None]


def sub_voice(note: int, t: np.ndarray) -> np.ndarray:
    freq = hz(note)
    tone = sine(freq, t) + 0.3 * sine(2 * freq, t) + 0.08 * sine(3 * freq, t)
    return panned(tone)


AIR_CHORUS = (1.0, 1.0012, 0.9985)  # slight detune: a few Hz of beating


def air_voice(note: int, t: np.ndarray) -> np.ndarray:
    """A shimmering cluster (beating detuned sines) that swells slowly."""
    freq = hz(note)
    cluster = total(
        (sine(freq * ratio, t, i) for i, ratio in enumerate(AIR_CHORUS)), t
    )
    swell_lfo = 0.55 + 0.45 * sine(0.09 + 0.031 * (note % 7), t, note)
    pan = 0.6 if note % 2 else -0.6
    return panned(cluster / len(AIR_CHORUS) * swell_lfo, pan)


def render_chord_layer(
    segments: list[Segment],
    pick: Callable[[Chord], tuple[int, ...]],
    voice: Callable[[int, np.ndarray], np.ndarray],
    t: np.ndarray,
) -> np.ndarray:
    """Each note is one continuous oscillator whose gain follows the chords
    that contain it, so common tones never re-attack at a chord change."""
    out = np.zeros((len(t), 2))
    notes = sorted({note for s in segments for note in pick(s.chord)})
    for note in notes:
        gain = np.zeros_like(t)
        for index, segment in enumerate(segments):
            if note in pick(segment.chord):
                gain += segment_weight(segments, index, t)
        active = np.flatnonzero(gain > 1e-4)
        if active.size == 0:
            continue
        span = slice(active[0], active[-1] + 1)
        out[span] += voice(note, t[span]) * gain[span, None]
    return out


PLUCK_HARMONICS = 8


def pluck_bass(note: int) -> np.ndarray:
    """Low pluck whose upper harmonics die first (a closing filter)."""
    t = time_axis(0.4)
    freq = hz(note)
    harmonics = range(1, PLUCK_HARMONICS + 1)
    tone = total(
        (sine(freq * k, t) / k * np.exp(-t * (5 + 10 * k)) for k in harmonics),
        t,
    )
    return tone * attack(t, 0.004) * taper(t, 0.03)


def kick() -> np.ndarray:
    t = time_axis(0.35)
    freq = 46 + 60 * np.exp(-t * 30)
    phase = 2 * np.pi * np.cumsum(freq) / RATE
    return np.sin(phase) * np.exp(-t * 13) * attack(t, 0.0015) * taper(t, 0.03)


def hat(bank: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    t = time_axis(0.07)
    start = rng.integers(0, len(bank) - len(t))
    noise = bank[start : start + len(t)]
    return noise * np.exp(-t / 0.016) * attack(t, 0.0008) * taper(t, 0.01)


def glass(note: int, length_s: float = 0.9, tau: float = 0.22) -> np.ndarray:
    t = time_axis(length_s)
    freq = hz(note)
    tone = sine(freq, t) * np.exp(-t / tau)
    tone += 0.2 * sine(2 * freq, t) * np.exp(-t / (tau / 3))
    return tone * attack(t, 0.003) * taper(t, 0.05)


def caret_pulse(chord: Chord) -> np.ndarray:
    """A soft ping over a low thump: one caret blink."""
    t = time_axis(0.6)
    ping = sine(hz(chord.ping), t) * np.exp(-t / 0.14) * attack(t, 0.004)
    thump = sine(hz(chord.bass[-1]), t) * np.exp(-t / 0.09) * attack(t, 0.006)
    mono = CARET_PING_GAIN * ping + CARET_THUMP_GAIN * thump
    return panned(mono * taper(t, 0.05))


def chime(notes: tuple[int, ...]) -> np.ndarray:
    t = time_axis(3.0)
    tone = total(
        (
            sine(hz(note), t, i) * np.exp(-t / (1.2 - 0.15 * i))
            for i, note in enumerate(notes)
        ),
        t,
    )
    return panned(tone * attack(t, 0.01) * taper(t, 0.3))


def swell(rng: np.random.Generator, shape: Swell) -> np.ndarray:
    """Filtered-noise swell: opens up to the peak, then closes and fades."""
    length = shape.rise_s + shape.fall_s

    def cutoff(sec: np.ndarray) -> np.ndarray:
        up = np.clip(sec / shape.rise_s, 0, 1)
        down = np.clip((sec - shape.rise_s) / shape.fall_s, 0, 1)
        rising = shape.start_hz * (shape.peak_hz / shape.start_hz) ** up
        falling = shape.peak_hz * (shape.end_hz / shape.peak_hz) ** down
        return np.where(sec < shape.rise_s, rising, falling)

    t = time_axis(length)
    after = np.clip((t - shape.rise_s) / shape.fall_s, 0, 1)
    opening = (t / shape.rise_s) ** 2.5
    env = np.where(t < shape.rise_s, opening, (1 - after) ** 3)
    noise = [swept_noise(rng, length, cutoff) for _ in range(2)]
    return np.stack(noise, axis=1) * (env * shape.gain)[:, None]
