"""timeline.json loading, frame math and the Segment schedule.

src/promo/timeline.json is the timing source of truth: every section change,
transition swell and sound effect is computed from it, so re-running
generate-promo-audio.py after the narration pipeline rewrites the timeline
keeps the audio in sync.

The toggle_click_frame()/approve_confirm_frame() functions mirror the exact
formulas of src/promo/scenes/S04Optin.tsx and S05Approval.tsx (via
phrase_frame()/cue_frame(), themselves mirrors of src/promo/timeline.ts
phraseFrame()/cueFrame()) so the sound never drifts from the video beat.
"""

from __future__ import annotations

import json
import math
import re

import numpy as np

from .constants import (
    APPROVE_CHORD,
    APPROVE_CROSSFADE_S,
    APPROVE_CUE,
    APPROVE_SCENE_ID,
    CAMERA_HALF_FRAMES,
    CARET_BLINK_FRAMES,
    CARET_SCENES,
    CHORDS,
    Chord,
    CURSOR_TO_CONFIRM_FRAMES,
    ENTER_FRAMES,
    EVIDENCE_PHRASE,
    METHODS_COUNT,
    MIN_POINTER_TRAVEL_FRAMES,
    OVERVIEW_CHORD,
    OVERVIEW_CUE,
    OVERVIEW_MORPH_FRAMES,
    OVERVIEW_SCENE_ID,
    PERMIT_PHRASE,
    POINTER_APPEAR_FRAMES,
    REVIEW_COMMAND,
    REVIEW_TARGET,
    SCENE_CHORDS,
    SECTIONS,
    STAGGER_FRAMES,
    TIMELINE_PATH,
    TOGGLE_CUE,
    TOGGLE_SCENE_ID,
    TTY_AFTER_ARRIVAL_FRAMES,
    TYPE_PAUSE_FRAMES,
    Segment,
)

# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------


def load_timeline() -> dict:
    return json.loads(TIMELINE_PATH.read_text(encoding="utf-8"))


def seconds(frames: float, timeline: dict) -> float:
    return frames / timeline["fps"]


def duration_of(timeline: dict) -> float:
    return seconds(timeline["totalFrames"], timeline)


def scene_by_id(timeline: dict, scene_id: str) -> dict:
    for scene in timeline["scenes"]:
        if scene["id"] == scene_id:
            return scene
    raise KeyError(f"timeline.json has no scene {scene_id!r}")


def cue_time(timeline: dict, scene_id: str, cue: int) -> float:
    """Absolute seconds of the start of caption chunk c<cue> of a scene."""
    scene = scene_by_id(timeline, scene_id)
    frame = scene["startFrame"] + cue_frame(scene, cue)
    return seconds(frame, timeline)


def cue_frame(scene: dict, cue: int, offset_frames: int = 0) -> int:
    """Scene-relative start frame of caption chunk c<cue>, plus frames.

    Mirrors timeline.ts cueFrame(); scene["captions"][*]["startFrame"] is
    already scene-relative (see build-promo-timeline.mjs captionFrames()).
    """
    return scene["captions"][cue - 1]["startFrame"] + offset_frames


def count_spoken_chars(text: str) -> int:
    """Mirrors timeline.ts countSpokenChars(): length with whitespace removed."""
    return len(re.sub(r"\s", "", text))


def js_round(value: float) -> int:
    """Math.round(): halves round up (unlike Python's round-half-to-even)."""
    return math.floor(value + 0.5)


def phrase_frame(scene: dict, phrase: str, offset_frames: int = 0) -> int:
    """Scene-relative frame `phrase` is (approximately) spoken.

    Mirrors timeline.ts phraseFrame(): interpolates the phrase's character
    position inside the caption chunk that contains it.
    """
    caption = next((c for c in scene["captions"] if phrase in c["text"]), None)
    if caption is None:
        raise KeyError(f"{scene['id']}: no caption contains {phrase!r}")
    before = count_spoken_chars(caption["text"][: caption["text"].index(phrase)])
    ratio = before / max(1, count_spoken_chars(caption["text"]))
    span = caption["endFrame"] - caption["startFrame"]
    return js_round(caption["startFrame"] + ratio * span) + offset_frames


def toggle_click_frame(scene: dict) -> int:
    """Scene-relative frame the s04 toggle starts turning on.

    Mirrors S04Optin.tsx optinCues(): listAt -> commentAt -> pointerAt ->
    clickAt (`cues.clickAt`, passed to OptinList as `onAt`).
    """
    arrival = CAMERA_HALF_FRAMES  # useSceneTime().arrival (scene index > 0)
    list_at = arrival + ENTER_FRAMES / 2
    comment_at = list_at + (METHODS_COUNT + 1) * STAGGER_FRAMES
    pointer_at = max(comment_at + ENTER_FRAMES, cue_frame(scene, TOGGLE_CUE))
    return js_round(
        max(
            pointer_at + POINTER_APPEAR_FRAMES + MIN_POINTER_TRAVEL_FRAMES,
            phrase_frame(scene, PERMIT_PHRASE),
        )
    )


def approve_confirm_frame(scene: dict) -> int:
    """Scene-relative frame approve is confirmed (the stamp beat).

    Mirrors S05Approval.tsx approvalCues(): frameAt -> commandAt -> outputAt
    -> evidenceAt -> cursorAt -> confirmAt (`cues.confirmAt`).
    """
    arrival = CAMERA_HALF_FRAMES  # useSceneTime().arrival (scene index > 0)
    frame_at = arrival + TTY_AFTER_ARRIVAL_FRAMES
    command_at = frame_at + ENTER_FRAMES / 2
    review_command_frames = len(f"{REVIEW_COMMAND} {REVIEW_TARGET}")
    output_at = command_at + review_command_frames + TYPE_PAUSE_FRAMES
    evidence_at = max(
        phrase_frame(scene, EVIDENCE_PHRASE), output_at + ENTER_FRAMES
    )
    cursor_at = max(cue_frame(scene, APPROVE_CUE), evidence_at + ENTER_FRAMES)
    return js_round(cursor_at + CURSOR_TO_CONFIRM_FRAMES)


def toggle_time(timeline: dict) -> float:
    """Absolute seconds the s04 toggle starts turning on (the click SFX)."""
    scene = scene_by_id(timeline, TOGGLE_SCENE_ID)
    return seconds(scene["startFrame"] + toggle_click_frame(scene), timeline)


def approve_time(timeline: dict) -> float:
    """Absolute seconds approve is confirmed (the stamp SFX and BGM resolve)."""
    scene = scene_by_id(timeline, APPROVE_SCENE_ID)
    return seconds(scene["startFrame"] + approve_confirm_frame(scene), timeline)


def camera_window(timeline: dict, scene: dict) -> tuple[float, float]:
    start = scene["startFrame"]
    return (
        seconds(start - CAMERA_HALF_FRAMES, timeline),
        seconds(start + CAMERA_HALF_FRAMES, timeline),
    )


def arrival_times(timeline: dict) -> list[float]:
    """When the camera settles on each station after the first."""
    return [camera_window(timeline, s)[1] for s in timeline["scenes"][1:]]


def caret_times(timeline: dict) -> list[float]:
    """Caret "on" onsets (every 2 blinks) in the caret scenes."""
    period = 2 * CARET_BLINK_FRAMES
    times = []
    for scene_id, from_frame in CARET_SCENES.items():
        scene = scene_by_id(timeline, scene_id)
        first = -(-from_frame // period) * period
        for frame in range(first, scene["durationFrames"], period):
            times.append(seconds(scene["startFrame"] + frame, timeline))
    return times


def build_segments(timeline: dict) -> list[Segment]:
    segments = []
    for scene in timeline["scenes"]:
        window = (0.0, 0.0)
        if scene["startFrame"] > 0:
            window = camera_window(timeline, scene)
        chord = CHORDS[SCENE_CHORDS[scene["id"]]]
        segments.append(Segment(*window, chord, SECTIONS[scene["id"]]))
    approve = approve_time(timeline)
    overview = cue_time(timeline, OVERVIEW_SCENE_ID, OVERVIEW_CUE)
    morph = seconds(OVERVIEW_MORPH_FRAMES, timeline)
    segments += [
        Segment(approve, approve + APPROVE_CROSSFADE_S, CHORDS[APPROVE_CHORD],
                SECTIONS[APPROVE_SCENE_ID]),
        Segment(overview, overview + morph, CHORDS[OVERVIEW_CHORD],
                SECTIONS["overview"]),
    ]
    return sorted(segments, key=lambda segment: segment.start)


# ---------------------------------------------------------------------------
# Automation
# ---------------------------------------------------------------------------


def section_curve(
    segments: list[Segment], field: str, t: np.ndarray
) -> np.ndarray:
    """A section parameter over time, ramping across each crossfade."""
    values = [getattr(segment.section, field) for segment in segments]
    xs, ys = [0.0], [values[0]]
    for before, segment, after in zip(values, segments[1:], values[1:]):
        xs += [segment.start, segment.end]
        ys += [before, after]
    return np.interp(t, xs, ys)


def raised_cosine(x: np.ndarray) -> np.ndarray:
    return 0.5 - 0.5 * np.cos(np.pi * np.clip(x, 0.0, 1.0))


def rise(segment: Segment, t: np.ndarray) -> np.ndarray:
    if segment.end <= segment.start:
        return (t >= segment.start).astype(float)
    return raised_cosine((t - segment.start) / (segment.end - segment.start))


def segment_weight(
    segments: list[Segment], index: int, t: np.ndarray
) -> np.ndarray:
    """0→1→0 presence of one segment; neighbours always sum to 1."""
    weight = rise(segments[index], t)
    if index + 1 < len(segments):
        weight = weight - rise(segments[index + 1], t)
    return weight


def chord_at(segments: list[Segment], time: float) -> Chord:
    """The chord a note starting at `time` should use."""
    current = segments[0].chord
    for segment in segments:
        if (segment.start + segment.end) / 2 <= time:
            current = segment.chord
    return current
