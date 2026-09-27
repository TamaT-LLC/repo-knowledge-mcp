import type { ReactNode } from "react";

import { OVERVIEW_CUE } from "../camera";
import { AgentRows } from "../components/AgentRows";
import { Headline } from "../components/Headline";
import { RelitReview } from "../components/RelitReview";
import { ScreenSpace } from "../components/Space";
import { ThreadPulse } from "../components/ThreadPulse";
import { type SceneTime, useSceneTime } from "../context";
import { headlineOf } from "../story";
import {
  COLOR_SHIFT_FRAMES,
  ENTER_FRAMES,
  OVERVIEW_MORPH_FRAMES,
} from "../theme";
import type { SceneProps } from "./types";

// s07-agents: the three agent names enter as they are read (c1); at c2 the
// same rule wipes into all three rows at once, perfectly aligned. At c3 the
// World morphs into the overview; the rows fade out (the one fade the
// storyboard allows), a light runs back along the thread to PR and the
// original review comment lights up again.
//
// Everything that belongs to this station lives in screen space, because the
// overview morph displaces station 6. The headline wipes out as the morph
// starts: its message is replaced by "元のレビューまで、たどれます".

const PR_STATION = 0;
/** The light leaves once the morph has mostly settled, so it stays on screen. */
const PULSE_DELAY_FRAMES = (OVERVIEW_MORPH_FRAMES * 3) / 4;
const PULSE_FRAMES = ENTER_FRAMES;
/** Minimum time the re-lit comment is held before the camera leaves. */
const RELIT_HOLD_FRAMES = ENTER_FRAMES;

type TraceBeats = {
  readonly overview: number;
  readonly pulse: number;
  readonly relit: number;
};

function traceBeats(time: SceneTime): TraceBeats {
  const overview = time.cue(OVERVIEW_CUE);
  const latestPulse =
    time.departure - PULSE_FRAMES - COLOR_SHIFT_FRAMES - RELIT_HOLD_FRAMES;
  const pulse = Math.min(overview + PULSE_DELAY_FRAMES, latestPulse);
  return { overview, pulse, relit: pulse + PULSE_FRAMES };
}

export function S07Agents({ scene, stationIndex }: SceneProps): ReactNode {
  const time = useSceneTime();
  const beats = traceBeats(time);
  return (
    <>
      <ScreenSpace>
        <Headline text={headlineOf(scene.id)} exitAt={beats.overview} />
        <AgentRows fadeAt={beats.overview} />
      </ScreenSpace>
      <ThreadPulse
        fromStation={stationIndex}
        toStation={PR_STATION}
        at={beats.pulse}
        duration={PULSE_FRAMES}
      />
      <RelitReview
        station={PR_STATION}
        at={beats.overview}
        litAt={beats.relit}
        exitAt={time.exitAt}
      />
    </>
  );
}
