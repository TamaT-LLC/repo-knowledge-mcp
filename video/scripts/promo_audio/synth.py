"""Pure NumPy DSP helpers: oscillators, envelopes and frequency-domain filters.

Nothing here reads timeline.json or knows about chords/instruments; see
instruments.py for the sustained voices and one-shot sounds built on top of
these, and music.py/sfx.py for what uses them.
"""

from __future__ import annotations

from typing import Callable, Iterable

import numpy as np

from .constants import HANN_SQUARED_OVERLAP, RATE, STFT_HOP, STFT_SIZE, SWELL_HIGHPASS_HZ

# ---------------------------------------------------------------------------
# DSP helpers
# ---------------------------------------------------------------------------


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def samples(duration_s: float) -> int:
    return int(round(duration_s * RATE))


def time_axis(duration_s: float) -> np.ndarray:
    return np.arange(samples(duration_s)) / RATE


def sine(freq: float, t: np.ndarray, phase: float = 0.0) -> np.ndarray:
    return np.sin(2 * np.pi * freq * t + phase)


def total(signals: Iterable[np.ndarray], like: np.ndarray) -> np.ndarray:
    """Sum of signals shaped like `like` (an array even if none are given)."""
    out = np.zeros_like(like)
    for signal in signals:
        out += signal
    return out


def attack(t: np.ndarray, duration_s: float) -> np.ndarray:
    return np.minimum(t / duration_s, 1.0)


def taper(t: np.ndarray, duration_s: float) -> np.ndarray:
    """Linear fade over the last `duration_s` of a clip (no end clicks)."""
    return np.clip((t[-1] - t) / duration_s, 0.0, 1.0)


def panned(mono: np.ndarray, pan: float = 0.0) -> np.ndarray:
    gains = np.sqrt(np.array([1 - pan, 1 + pan]) / 2)
    return mono[:, None] * gains


def widen(stereo: np.ndarray, width: np.ndarray) -> np.ndarray:
    mid = (stereo[:, 0] + stereo[:, 1]) / 2
    side = (stereo[:, 0] - stereo[:, 1]) / 2 * width
    return np.stack([mid + side, mid - side], axis=1)


def place(track: np.ndarray, clip: np.ndarray, at: float, gain: float) -> None:
    start = samples(at)
    skip = max(0, -start)
    start = max(0, start)
    count = min(len(clip) - skip, len(track) - start)
    if count > 0:
        track[start : start + count] += clip[skip : skip + count] * gain


def butterworth(
    freqs: np.ndarray,
    lowpass: float | np.ndarray | None = None,
    highpass: float | None = None,
    order: int = 2,
) -> np.ndarray:
    """Butterworth magnitude response (cutoffs may be arrays)."""
    response = np.ones_like(freqs)
    if lowpass is not None:
        response = response / np.sqrt(1 + (freqs / lowpass) ** (2 * order))
    if highpass is not None:
        ratio = (freqs / highpass) ** (2 * order)
        response = response * np.sqrt(ratio / (1 + ratio))
    return response


def fft_filter(
    x: np.ndarray,
    lowpass: float | None = None,
    highpass: float | None = None,
    order: int = 2,
) -> np.ndarray:
    """Zero-phase filter in the frequency domain (padded: no wrap-around)."""
    size = 1 << int(np.ceil(np.log2(len(x) + RATE)))
    spectrum = np.fft.rfft(x, size, axis=0)
    freqs = np.fft.rfftfreq(size, 1 / RATE)
    response = butterworth(freqs, lowpass, highpass, order)
    shape = (-1,) + (1,) * (x.ndim - 1)
    filtered = spectrum * response.reshape(shape)
    return np.fft.irfft(filtered, size, axis=0)[: len(x)]


def band_noise(
    rng: np.random.Generator, count: int, band: tuple[float, float]
) -> np.ndarray:
    noise = rng.standard_normal(count)
    return fft_filter(noise, lowpass=band[1], highpass=band[0])


def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    spectrum = np.fft.rfft(x, size, axis=0) * np.fft.rfft(ir, size, axis=0)
    return np.fft.irfft(spectrum, size, axis=0)[: len(x)]


def reverb_ir(
    rng: np.random.Generator, length_s: float, predelay_s: float,
    damping_hz: float,
) -> np.ndarray:
    """Decorrelated stereo noise tail, -60 dB at `length_s`, unit energy."""
    t = time_axis(length_s)
    tail = rng.standard_normal((len(t), 2))
    tail *= np.exp(-6.91 * t / length_s)[:, None]
    tail = fft_filter(tail, lowpass=damping_hz)
    ir = np.concatenate([np.zeros((samples(predelay_s), 2)), tail])
    return ir / np.sqrt(np.sum(ir**2, axis=0))


def swept_noise(
    rng: np.random.Generator, length_s: float,
    cutoff_at: Callable[[np.ndarray], np.ndarray],
) -> np.ndarray:
    """Noise through a low-pass whose cutoff follows cutoff_at(seconds)."""
    count = samples(length_s)
    window = np.hanning(STFT_SIZE + 1)[:-1]
    noise = rng.standard_normal(count + STFT_SIZE)
    starts = np.arange(0, len(noise) - STFT_SIZE + 1, STFT_HOP)
    frames = noise[starts[:, None] + np.arange(STFT_SIZE)] * window
    freqs = np.fft.rfftfreq(STFT_SIZE, 1 / RATE)[None, :]
    cutoff = cutoff_at(starts / RATE)[:, None]
    response = butterworth(freqs, cutoff, SWELL_HIGHPASS_HZ)
    spectra = np.fft.rfft(frames, axis=1) * response
    shaped = np.fft.irfft(spectra, STFT_SIZE, axis=1) * window
    out = np.zeros(len(noise))
    for start, frame in zip(starts, shaped):
        out[start : start + STFT_SIZE] += frame
    half = STFT_SIZE // 2
    return out[half : half + count] / HANN_SQUARED_OVERLAP
