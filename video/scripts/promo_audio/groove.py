"""The rhythm grid, kick pattern and its sidechain-style pump envelope.

Bus (the dry+send mix accumulator) also lives here since kick_hits()'s output
feeds pump_envelope() before any layer is added to one. music.py's add_*
functions build the actual layers on top of these.
"""

from __future__ import annotations

import numpy as np

from .constants import (
    KICK_EVERY_BEATS,
    PUMP_DEPTH,
    PUMP_RELEASE_S,
    PUMP_TAIL_TAUS,
    Segment,
    SIXTEENTH_S,
    STEPS_PER_BEAT,
)
from .synth import attack, place, samples
from .timeline import arrival_times, duration_of, section_curve

# ---------------------------------------------------------------------------
# Groove grid and kick/pump
# ---------------------------------------------------------------------------


class Bus:
    """Dry mix plus a reverb send."""

    def __init__(self, count: int) -> None:
        self.dry = np.zeros((count, 2))
        self.send = np.zeros((count, 2))

    def add(self, signal: np.ndarray, gain: float, send: float) -> None:
        self.dry += signal * gain
        self.send += signal * (gain * send)

    def place(
        self, clip: np.ndarray, at: float, gain: float, send: float
    ) -> None:
        place(self.dry, clip, at, gain)
        place(self.send, clip, at, gain * send)


def groove_steps(timeline: dict) -> tuple[np.ndarray, np.ndarray]:
    """16th-note grid (index 0 = the s02 arrival downbeat) and its times."""
    anchor = arrival_times(timeline)[0]
    first = int(np.ceil(-anchor / SIXTEENTH_S))
    last = int(np.floor((duration_of(timeline) - anchor) / SIXTEENTH_S))
    index = np.arange(first, last + 1)
    return index, anchor + index * SIXTEENTH_S


def kick_hits(
    timeline: dict, segments: list[Segment]
) -> list[tuple[float, float]]:
    index, times = groove_steps(timeline)
    levels = section_curve(segments, "kick", times)
    on_grid = index % (STEPS_PER_BEAT * KICK_EVERY_BEATS) == 0
    return [
        (time, level)
        for time, level, is_kick in zip(times, levels, on_grid)
        if is_kick and level > 0
    ]


def pump_envelope(
    hits: list[tuple[float, float]], t: np.ndarray
) -> np.ndarray:
    envelope = np.ones_like(t)
    span = samples(PUMP_RELEASE_S * PUMP_TAIL_TAUS)
    for time, level in hits:
        start = samples(time)
        local = t[start : start + span] - time
        dip = PUMP_DEPTH * level * np.exp(-local / PUMP_RELEASE_S)
        dip *= attack(local, 0.005)
        envelope[start : start + span] = np.minimum(
            envelope[start : start + span], 1 - dip
        )
    return envelope
