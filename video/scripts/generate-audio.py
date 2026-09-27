"""Generate either edition's original soundtrack. Requires numpy and ffmpeg."""

import argparse
import json
import math
from pathlib import Path
import subprocess
import wave

import numpy as np

RATE = 48000
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--edition", choices=("original", "quick"), default="original")
args = parser.parse_args()
settings = json.loads((ROOT / "src" / "editions.json").read_text())[args.edition]
QUICK = args.edition == "quick"
DURATION = sum(settings["frames"]) / 30
BEAT = 60 / settings["bpm"]
BAR = BEAT * 8
DEST = ROOT / "public" / "audio"
DEST.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(42)
mix = np.zeros((round(RATE * DURATION), 2), dtype=np.float64)


def add(signal, at, gain=1.0, pan=0.0):
    offset = int(at * RATE)
    count = min(len(signal), len(mix) - offset)
    if count <= 0:
        return
    gains = np.sqrt(np.array([1 - pan, 1 + pan]) / 2) * gain
    mix[offset : offset + count] += signal[:count, None] * gains


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def tone(note, duration, kind="pluck"):
    t = np.arange(int(duration * RATE)) / RATE
    frequency = hz(note)
    if kind == "pad":
        signal = (
            np.sin(2 * np.pi * frequency * t)
            + 0.30 * np.sin(2 * np.pi * frequency * 1.003 * t)
            + 0.14 * np.sin(2 * np.pi * frequency * 2 * t)
        )
        env = np.minimum(t / 0.7, 1) * np.minimum((duration - t) / 1.1, 1)
    else:
        signal = np.sin(2 * np.pi * frequency * t)
        signal += 0.24 * np.sin(2 * np.pi * frequency * 2 * t) * np.exp(-t * 7)
        signal += 0.08 * np.sin(2 * np.pi * frequency * 3 * t) * np.exp(-t * 10)
        env = (1 - np.exp(-t * 180)) * np.exp(-t * 3.2)
    return signal * env


# Dm9, Bbmaj7, Fmaj9, Cadd9: restrained, optimistic electronic bed.
chords = [(50, 57, 60, 64), (46, 53, 57, 62), (53, 57, 60, 67), (48, 55, 62, 64)]
pattern = [0, 2, 1, 3, 2, 1, 3, 2]
for bar in range(math.ceil(DURATION / BAR)):
    start = bar * BAR
    chord = chords[bar % len(chords)]
    for i, note in enumerate(chord):
        add(tone(note, BAR + 1, "pad"), start, 0.055, (i - 1.5) / 3)
    for beat in range(8):
        note = chord[pattern[beat]] + 12
        at = start + beat * BEAT
        pluck = tone(note, 1.7)
        add(pluck, at, 0.12 if QUICK else 0.11, -0.28 if beat % 2 else 0.28)
        add(pluck, at + BEAT * 0.75, 0.027, 0.45 if beat % 2 else -0.45)

drum_start = BEAT if QUICK else 2
for beat in range(math.ceil((DURATION - 2 - drum_start) / BEAT)):
    at = drum_start + beat * BEAT
    t = np.arange(int(0.24 * RATE)) / RATE
    phase = 2 * np.pi * (48 * t + (65 / 25) * (1 - np.exp(-25 * t)))
    kick = np.sin(phase) * np.exp(-t * 21) * (1 - np.exp(-t * 300))
    add(kick, at, 0.13 if beat % 4 == 0 else 0.07)
    if beat % 2:
        n = rng.standard_normal(int(0.08 * RATE))
        n = np.concatenate(([0], np.diff(n)))
        add(n * np.exp(-np.arange(len(n)) / RATE * 90), at + BEAT / 2, 0.012 if QUICK else 0.009, 0.2)

# Gentle arrival tones line up with chapter transitions.
transitions = [sum(settings["frames"][:i]) / 30 for i in range(1, len(settings["frames"]))]
for at in transitions:
    add(tone(81, 2.1), at + 0.05, 0.085, -0.2)
    add(tone(88, 1.5), at + 0.17, 0.025, 0.25)

t = np.arange(len(mix)) / RATE
fade = np.minimum(t / (0.7 if QUICK else 1.5), 1) * np.minimum((DURATION - t) / (1.8 if QUICK else 3.5), 1)
mix *= fade[:, None]
mix *= 0.68 / np.max(np.abs(mix))
audio_path = ROOT / "public" / settings["audio"]
wav = audio_path.with_suffix(".wav")
with wave.open(str(wav), "wb") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(RATE)
    output.writeframes((mix * 32767).astype("<i2").tobytes())
subprocess.run(
    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav),
     "-c:a", "aac", "-b:a", "192k", "-af", "loudnorm=I=-20:TP=-2:LRA=7",
     "-ar", "48000", str(audio_path)],
    check=True,
)
print(f"Generated {audio_path}: {DURATION:g}s, {settings['bpm']} BPM")
