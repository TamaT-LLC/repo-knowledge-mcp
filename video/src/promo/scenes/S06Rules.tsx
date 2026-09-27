import type { ReactNode } from "react";

import { CONNECTOR_FRAMES } from "../camera";
import { DockingToken, dockedFrame } from "../components/DockingToken";
import { Headline } from "../components/Headline";
import { Note } from "../components/Note";
import {
  type RulesBeats,
  RulesBranches,
  type RulesLayout,
  RulesRequest,
  RulesResponse,
} from "../components/RulesBlocks";
import {
  codeLineCenter,
  type DataGridSpec,
  requestHeight,
  responseHeight,
  ruleTextAnchor,
} from "../components/RulesData";
import { StationSpace } from "../components/Space";
import { ThreadPulse } from "../components/ThreadPulse";
import {
  type SceneTime,
  useLayout,
  useSceneTime,
  useStationToScreen,
} from "../context";
import { getLayout, type Orientation } from "../layout";
import { headlineOf, TOKEN_TAGS } from "../story";
import {
  CAMERA_FRAMES,
  ENTER_FRAMES,
  EXIT_FRAMES,
  STAGGER_FRAMES,
} from "../theme";
import { secondsToFrames } from "../timeline";
import type { SceneProps } from "./types";

// s06-rules: during c1 the agent's get_rules request appears; at c2 a light
// runs on the thread from the request to the response; at c3 the response
// rows enter 3 frames apart and, 0.6s later, the active hero token docks on
// the rule row's first words and dissolves into them (s07/s08 draw no token).

const NOTE = "README の例をもとにした簡略表示";
const CODE_TERMS = ["get_rules"] as const;
/** Same props as the s05 token on its last frame. */
const TOKEN_TAG = { text: TOKEN_TAGS.active, variant: "active" } as const;

/** The request starts a beat after the headline… */
const REQUEST_DELAY_FRAMES = ENTER_FRAMES / 2;
/** …and builds line by line (agent, call, arguments). */
const REQUEST_STEP_FRAMES = 10;
const PULSE_FRAMES = 20;
/** Storyboard: the token slides in 0.6s after c3. */
const TOKEN_SLIDE_DELAY_SECONDS = 0.6;
const SLIDE_FRAMES = CAMERA_FRAMES;
/** The pill rests on the rule this long before it wipes into the text. */
const DOCK_HOLD_FRAMES = 6;
/** Space between a block and the branch that joins it to the thread. */
const BRANCH_GAP_PX = 22;

// 16:9: request left (x=120–760), response right (x=880–1800), both joined
// to the thread below. Both use 34px so the two columns fit side by side
// and the rule still breaks into exactly two lines.
const LANDSCAPE_ARGS: DataGridSpec = {
  x: 120,
  y: 470,
  size: 34,
  keyColumn: 196,
  width: 660,
};
const LANDSCAPE_RESPONSE: DataGridSpec = {
  x: 880,
  y: 336,
  size: 34,
  keyColumn: 282,
  width: 920,
};

// 9:16: request above the response, both right of the vertical thread.
const PORTRAIT_CALL = { x: 156, y: 626 } as const;
const PORTRAIT_ARGS: DataGridSpec = {
  x: 156,
  y: 690,
  size: 34,
  keyColumn: 196,
  width: 852,
};
const PORTRAIT_RESPONSE: DataGridSpec = {
  x: 156,
  y: 850,
  size: 32,
  keyColumn: 262,
  width: 852,
};
/** Portrait branches stop short of the text column (x=156). */
const PORTRAIT_BRANCH_END = 140;

const RULES_LAYOUTS: Readonly<Record<Orientation, RulesLayout>> = {
  landscape: {
    agent: { x: 120, y: 336 },
    call: { x: 120, y: 394 },
    args: LANDSCAPE_ARGS,
    response: LANDSCAPE_RESPONSE,
    requestBranch: {
      along: getLayout("landscape").nodeAnchor,
      cross: LANDSCAPE_ARGS.y + requestHeight(LANDSCAPE_ARGS) + BRANCH_GAP_PX,
      ring: "node",
    },
    responseBranch: {
      along: LANDSCAPE_RESPONSE.x,
      cross:
        LANDSCAPE_RESPONSE.y +
        responseHeight(LANDSCAPE_RESPONSE) +
        BRANCH_GAP_PX,
      ring: "tick",
    },
  },
  portrait: {
    agent: { x: 156, y: 576 },
    call: PORTRAIT_CALL,
    args: PORTRAIT_ARGS,
    response: PORTRAIT_RESPONSE,
    requestBranch: {
      along: codeLineCenter(PORTRAIT_CALL.y, getLayout("portrait").type.code),
      cross: PORTRAIT_BRANCH_END,
      ring: "tick",
    },
    responseBranch: {
      along: codeLineCenter(PORTRAIT_RESPONSE.y, PORTRAIT_RESPONSE.size),
      cross: PORTRAIT_BRANCH_END,
      ring: "tick",
    },
  },
};

function rulesBeats(time: SceneTime): RulesBeats {
  const agent = Math.max(time.cue("c1"), time.arrival) + REQUEST_DELAY_FRAMES;
  const call = agent + REQUEST_STEP_FRAMES;
  const args = call + REQUEST_STEP_FRAMES;
  const pulse = Math.max(time.cue("c2"), args + CONNECTOR_FRAMES);
  const arrive = pulse + PULSE_FRAMES;
  const response = Math.max(time.cue("c3"), arrive);
  // The token must be absorbed before the camera leaves.
  const latestSlide =
    time.departure - SLIDE_FRAMES - DOCK_HOLD_FRAMES - EXIT_FRAMES;
  const slide = Math.min(
    Math.max(
      time.cue("c3", secondsToFrames(TOKEN_SLIDE_DELAY_SECONDS)),
      response + STAGGER_FRAMES,
    ),
    latestSlide,
  );
  const docked = dockedFrame(slide, SLIDE_FRAMES);
  return {
    agent,
    call,
    args,
    requestBranch: pulse - CONNECTOR_FRAMES,
    pulse,
    arrive,
    response,
    slide,
    docked,
    absorb: docked + DOCK_HOLD_FRAMES,
  };
}

export function S06Rules({
  scene,
  orientation,
  stationIndex,
}: SceneProps): ReactNode {
  const layout = useLayout();
  const toScreen = useStationToScreen();
  const time = useSceneTime();
  const spec = RULES_LAYOUTS[orientation];
  const beats = rulesBeats(time);
  return (
    <>
      <StationSpace>
        <Headline text={headlineOf(scene.id)} codeTerms={CODE_TERMS} />
        <RulesBranches spec={spec} beats={beats} />
        <RulesRequest spec={spec} beats={beats} />
        <RulesResponse spec={spec} beats={beats} />
      </StationSpace>
      <ThreadPulse
        fromStation={stationIndex}
        fromOffset={spec.requestBranch.along - layout.nodeAnchor}
        toStation={stationIndex}
        toOffset={spec.responseBranch.along - layout.nodeAnchor}
        at={beats.pulse}
        duration={PULSE_FRAMES}
      />
      <DockingToken
        variant="active"
        tag={TOKEN_TAG}
        slideAt={beats.slide}
        slideFrames={SLIDE_FRAMES}
        target={toScreen(ruleTextAnchor(spec.response))}
        targetSize={spec.response.size}
        absorbAt={beats.absorb}
      />
      <Note text={NOTE} at={beats.agent} />
    </>
  );
}
