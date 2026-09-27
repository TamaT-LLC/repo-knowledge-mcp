"""The BGM arrangement: pad/sub/air/drums/arp/cues layered onto a Bus.

render_bgm() is the entry point used by mix.py. See groove.py for the rhythm
grid, kick pattern and Bus itself.
"""

from __future__ import annotations

import numpy as np

from .constants import (
    AIR_NOISE_BAND_HZ,
    AIR_NOISE_GAIN,
    AIR_PARTIAL_GAIN,
    AIR_SEND,
    ARP_ECHO_GAIN,
    ARP_ECHO_STEPS,
    ARP_GAIN,
    ARP_PATTERN,
    ARP_SEND,
    ARP_TRANSPOSE,
    BASS_GAIN,
    BASS_SEND,
    CARET_SEND,
    CHIME_GAIN,
    CHIME_SEND,
    HAT_ACCENTS,
    HAT_BAND_HZ,
    HAT_GAIN,
    HAT_SEND,
    INTRO_FADE_S,
    KICK_GAIN,
    OUTRO_FADE_S,
    OVERVIEW_CUE,
    OVERVIEW_MORPH_FRAMES,
    OVERVIEW_SCENE_ID,
    OVERVIEW_SWELL,
    PAD_BRIGHT_HZ,
    PAD_DARK_HZ,
    PAD_GAIN,
    PAD_HIGHPASS_HZ,
    PAD_SEND,
    RATE,
    REVERB_BAND_HZ,
    REVERB_RETURN,
    SIXTEENTH_S,
    SPARKLE_GAIN,
    SPARKLE_MAX_RATE,
    SPARKLE_SEND,
    STEPS_PER_BEAT,
    SUB_GAIN,
    SUB_HIGHPASS_HZ,
    SUB_LOWPASS_HZ,
    SWELL_GAIN,
    SWELL_SEND,
    TRANSITION_SWELL,
    Segment,
)
from .groove import Bus, groove_steps, kick_hits, pump_envelope
from .instruments import (
    air_voice,
    caret_pulse,
    chime,
    glass,
    hat,
    kick,
    pad_voice,
    pluck_bass,
    render_chord_layer,
    sub_voice,
    swell,
)
from .synth import band_noise, convolve, fft_filter, panned, reverb_ir, samples, widen
from .timeline import (
    arrival_times,
    build_segments,
    caret_times,
    chord_at,
    cue_time,
    duration_of,
    raised_cosine,
    section_curve,
    seconds,
)

# ---------------------------------------------------------------------------
# BGM arrangement
# ---------------------------------------------------------------------------


def add_pad(
    bus: Bus, segments: list[Segment], t: np.ndarray, intro: np.ndarray,
    pump: np.ndarray,
) -> None:
    raw = render_chord_layer(segments, lambda c: c.pad, pad_voice, t)
    raw = fft_filter(raw, highpass=PAD_HIGHPASS_HZ)
    dark = fft_filter(raw, lowpass=PAD_DARK_HZ)
    bright = fft_filter(raw, lowpass=PAD_BRIGHT_HZ)
    openness = section_curve(segments, "pad_open", t)[:, None]
    pad = widen(dark + (bright - dark) * openness,
                section_curve(segments, "width", t))
    bus.add(pad * (intro * pump)[:, None], PAD_GAIN, PAD_SEND)


def add_sub(
    bus: Bus, segments: list[Segment], t: np.ndarray, intro: np.ndarray,
    pump: np.ndarray,
) -> None:
    sub = render_chord_layer(segments, lambda c: c.bass, sub_voice, t)
    sub = fft_filter(sub, lowpass=SUB_LOWPASS_HZ, highpass=SUB_HIGHPASS_HZ)
    level = section_curve(segments, "sub", t) * intro * pump
    bus.add(sub * level[:, None], SUB_GAIN, 0.0)


def add_air(
    bus: Bus, segments: list[Segment], t: np.ndarray, intro: np.ndarray,
    rng: np.random.Generator,
) -> None:
    partials = render_chord_layer(segments, lambda c: c.air, air_voice, t)
    noise = rng.standard_normal((len(t), 2))
    noise = fft_filter(noise, lowpass=AIR_NOISE_BAND_HZ[1],
                       highpass=AIR_NOISE_BAND_HZ[0])
    air = partials * AIR_PARTIAL_GAIN + noise * AIR_NOISE_GAIN
    air = widen(air, section_curve(segments, "width", t))
    level = section_curve(segments, "air", t) * intro
    bus.add(air * level[:, None], 1.0, AIR_SEND)


def add_sparkles(
    bus: Bus, segments: list[Segment], duration: float,
    rng: np.random.Generator,
) -> None:
    count = int(duration * SPARKLE_MAX_RATE)
    candidates = np.sort(rng.uniform(0, duration, count))
    rates = section_curve(segments, "sparkle", candidates)
    keep = rng.uniform(0, SPARKLE_MAX_RATE, count) < rates
    for time in candidates[keep]:
        note = int(rng.choice(chord_at(segments, time).air))
        grain = panned(glass(note, 0.35, 0.07), rng.uniform(-0.8, 0.8))
        gain = SPARKLE_GAIN * rng.uniform(0.4, 1.0)
        bus.place(grain, time, gain, SPARKLE_SEND)


def add_bass_and_kick(
    bus: Bus, timeline: dict, segments: list[Segment]
) -> None:
    index, times = groove_steps(timeline)
    on_level = section_curve(segments, "bass_on", times)
    off_level = section_curve(segments, "bass_off", times)
    for step, time, on, off in zip(index, times, on_level, off_level):
        position = step % STEPS_PER_BEAT
        level = on if position == 0 else off if position == 2 else 0.0
        if level > 0:
            note = chord_at(segments, time).bass[-1]
            bus.place(panned(pluck_bass(note)), time, BASS_GAIN * level,
                      BASS_SEND)
    for time, level in kick_hits(timeline, segments):
        bus.place(panned(kick()), time, KICK_GAIN * level, 0.0)


def add_hats(
    bus: Bus, timeline: dict, segments: list[Segment],
    rng: np.random.Generator,
) -> None:
    bank = band_noise(rng, RATE, HAT_BAND_HZ)
    index, times = groove_steps(timeline)
    levels = section_curve(segments, "hats", times)
    for step, time, level in zip(index, times, levels):
        if level > 0:
            accent = HAT_ACCENTS[step % STEPS_PER_BEAT]
            bus.place(panned(hat(bank, rng), 0.25), time,
                      HAT_GAIN * level * accent, HAT_SEND)


def add_arp(bus: Bus, timeline: dict, segments: list[Segment]) -> None:
    index, times = groove_steps(timeline)
    levels = section_curve(segments, "arp", times)
    for step, time, level in zip(index, times, levels):
        slot = ARP_PATTERN[step % len(ARP_PATTERN)]
        if level <= 0 or slot is None:
            continue
        chord = chord_at(segments, time)
        note = chord.pad[slot % len(chord.pad)] + ARP_TRANSPOSE
        side = 0.35 if step % 2 else -0.35
        tone = glass(note)
        bus.place(panned(tone, side), time, ARP_GAIN * level, ARP_SEND)
        echo_at = time + ARP_ECHO_STEPS * SIXTEENTH_S
        bus.place(panned(tone, -side), echo_at,
                  ARP_GAIN * level * ARP_ECHO_GAIN, ARP_SEND)


def add_cues(
    bus: Bus, timeline: dict, segments: list[Segment],
    rng: np.random.Generator,
) -> None:
    """Caret pulses, transition swells and the closing chime."""
    times = caret_times(timeline)
    levels = section_curve(segments, "caret", np.array(times))
    for time, level in zip(times, levels):
        if level > 0:
            clip = caret_pulse(chord_at(segments, time))
            bus.place(clip, time, level, CARET_SEND)
    arrivals = arrival_times(timeline)
    for arrival in arrivals:
        clip = swell(rng, TRANSITION_SWELL)
        bus.place(clip, arrival - TRANSITION_SWELL.rise_s, SWELL_GAIN,
                  SWELL_SEND)
    overview = cue_time(timeline, OVERVIEW_SCENE_ID, OVERVIEW_CUE)
    peak = overview + seconds(OVERVIEW_MORPH_FRAMES, timeline)
    bus.place(swell(rng, OVERVIEW_SWELL), peak - OVERVIEW_SWELL.rise_s,
              SWELL_GAIN, SWELL_SEND)
    home = chord_at(segments, arrivals[-1])
    notes = tuple(note - 12 for note in home.air)
    bus.place(chime(notes), arrivals[-1], CHIME_GAIN, CHIME_SEND)


def render_bgm(timeline: dict, rng: np.random.Generator) -> np.ndarray:
    duration = duration_of(timeline)
    t = np.arange(samples(duration)) / RATE
    segments = build_segments(timeline)
    intro = raised_cosine(t / INTRO_FADE_S)
    pump = pump_envelope(kick_hits(timeline, segments), t)
    bus = Bus(len(t))
    add_pad(bus, segments, t, intro, pump)
    add_sub(bus, segments, t, intro, pump)
    add_air(bus, segments, t, intro, rng)
    add_sparkles(bus, segments, duration, rng)
    add_bass_and_kick(bus, timeline, segments)
    add_hats(bus, timeline, segments, rng)
    add_arp(bus, timeline, segments)
    add_cues(bus, timeline, segments, rng)
    wet = convolve(bus.send, reverb_ir(rng, 2.8, 0.02, 6000))
    wet = fft_filter(wet, lowpass=REVERB_BAND_HZ[1],
                     highpass=REVERB_BAND_HZ[0])
    outro = raised_cosine((duration - t) / OUTRO_FADE_S)
    return (bus.dry + REVERB_RETURN * wet) * outro[:, None]
