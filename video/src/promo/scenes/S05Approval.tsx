import type { ReactNode } from "react";

import { Headline } from "../components/Headline";
import { HeroTokenSwap, heroTokenSwapEnd } from "../components/HeroTokenSwap";
import { Note } from "../components/Note";
import {
  ReviewTty,
  type ReviewTtyCues,
  type ReviewTtyLayout,
  reviewCommandFrames,
} from "../components/ReviewTty";
import { StationSpace } from "../components/Space";
import { StampRing } from "../components/StampRing";
import { StateTransition } from "../components/StateTransition";
import { SubTelop } from "../components/SubTelop";
import { type SceneTime, useLayout, useSceneTime } from "../context";
import type { Orientation, Point } from "../layout";
import { headlineOf, TOKEN_TAGS } from "../story";
import { ENTER_FRAMES, STAGGER_FRAMES } from "../theme";
import { secondsToFrames } from "../timeline";
import type { SceneProps } from "./types";

// s05-approval: a TTY frame shows `$ repo-knowledge review owner/repository`
// typing in, then the candidate, its evidence and approve / reject. At c2 a
// small telop says no MCP tool approves or rejects; at 「根拠」 the evidence
// row is highlighted once. At c3 the cursor lands on approve and confirms:
// approve turns vermilion and a vermilion ring spreads once from the frame
// (the stamp). 0.3s later the state goes proposed → active, in the state
// list and on the hero token, which leaves as active for s06.

const NOTE = "説明用の簡略表示";
const TELOP = "承認・却下を行う MCP tool は公開していません";
const EVIDENCE_PHRASE = "根拠";
/** Storyboard: the TTY starts to appear at about 0.5s. */
const TTY_AFTER_ARRIVAL_FRAMES = 6;
const TYPE_PAUSE_FRAMES = 2 * STAGGER_FRAMES;
/** The cursor lands on approve, then the key press confirms it. */
const CURSOR_TO_CONFIRM_FRAMES = 8;
/** Storyboard: the state switches 0.3s after approve is confirmed. */
const SWITCH_AFTER_CONFIRM_SECONDS = 0.3;

type ApprovalLayout = {
  readonly tty: ReviewTtyLayout;
  readonly state: Point;
  readonly stateVertical: boolean;
  readonly telop: Point;
};

const APPROVAL_LAYOUTS: Readonly<Record<Orientation, ApprovalLayout>> = {
  landscape: {
    tty: {
      box: { x: 120, y: 330, width: 1280, height: 340 },
      size: 36,
      split: false,
    },
    state: { x: 1470, y: 414 },
    stateVertical: true,
    telop: { x: 120, y: 690 },
  },
  portrait: {
    tty: {
      box: { x: 156, y: 560, width: 852, height: 430 },
      size: 34,
      split: true,
    },
    state: { x: 156, y: 1020 },
    stateVertical: false,
    telop: { x: 156, y: 1100 },
  },
};

type ApprovalCues = ReviewTtyCues & {
  readonly telopAt: number;
  readonly switchAt: number;
};

function approvalCues(time: SceneTime): ApprovalCues {
  const frameAt = time.arrival + TTY_AFTER_ARRIVAL_FRAMES;
  const commandAt = frameAt + ENTER_FRAMES / 2;
  const outputAt = commandAt + reviewCommandFrames() + TYPE_PAUSE_FRAMES;
  const evidenceAt = Math.max(
    time.phrase(EVIDENCE_PHRASE),
    outputAt + ENTER_FRAMES,
  );
  const cursorAt = Math.max(time.cue("c3"), evidenceAt + ENTER_FRAMES);
  const confirmAt = cursorAt + CURSOR_TO_CONFIRM_FRAMES;
  // The hero token must have settled on "active" by the last frame.
  const switchAt = Math.min(
    confirmAt + secondsToFrames(SWITCH_AFTER_CONFIRM_SECONDS),
    time.duration - 1 - heroTokenSwapEnd(0),
  );
  return {
    frameAt,
    commandAt,
    outputAt,
    evidenceAt,
    cursorAt,
    confirmAt,
    telopAt: Math.max(time.cue("c2"), outputAt),
    switchAt,
  };
}

export function S05Approval({ scene, orientation }: SceneProps): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const approval = APPROVAL_LAYOUTS[orientation];
  const cues = approvalCues(time);
  return (
    <>
      <StationSpace>
        <Headline text={headlineOf(scene.id)} />
        <ReviewTty tty={approval.tty} cues={cues} />
        <StampRing box={approval.tty.box} at={cues.confirmAt} />
        <StateTransition
          position={approval.state}
          vertical={approval.stateVertical}
          at={cues.outputAt}
          switchAt={cues.switchAt}
          size={layout.type.sub}
        />
        <SubTelop lines={[TELOP]} at={cues.telopAt} position={approval.telop} />
      </StationSpace>
      <HeroTokenSwap
        from={{ tag: { text: TOKEN_TAGS.proposed, variant: "sky" } }}
        to={{
          variant: "active",
          tag: { text: TOKEN_TAGS.active, variant: "active" },
        }}
        at={cues.switchAt}
      />
      <Note text={NOTE} at={cues.frameAt} />
    </>
  );
}
