import type { ReactNode } from "react";

import {
  FetchFlow,
  type FetchFlowCues,
  type FetchFlowLayout,
  fetchPulseEnd,
} from "../components/FetchFlow";
import { Headline } from "../components/Headline";
import { HeroToken } from "../components/HeroToken";
import { StationSpace } from "../components/Space";
import {
  StoreElbow,
  type StorePathLayout,
  StorePathText,
} from "../components/StorePath";
import { SubTelop } from "../components/SubTelop";
import { LeadInTokenCover, ThreadBadge } from "../components/ThreadBadge";
import {
  type SceneTime,
  useLayout,
  useSceneTime,
  useStationToScreen,
} from "../context";
import type { Orientation, Point } from "../layout";
import { mix, progress } from "../motion";
import { headlineOf, TOKEN_TAGS } from "../story";
import {
  CAMERA_FRAMES,
  EASE_CAMERA,
  ENTER_FRAMES,
  STAGGER_FRAMES,
} from "../theme";
import { secondsToFrames } from "../timeline";
import type { SceneProps } from "./types";

// s03-local: while the camera moves in, the hero token passes the "gh" badge
// on the thread and it blinks (fetched). c1 draws "Pull Request ─[gh CLI]─▶"
// and a pulse carries the review along it at 「取得」. At c2 the local path
// appears and the token docks under it with the raw evidence tag; 1s later a
// small telop states that the GitHub token stays with gh CLI. Before the
// scene ends the token leaves the dock and rides the focus again, carrying
// the tag into s04.

const GH_BADGE = "gh";
const GH_PHRASE = "gh CLI";
const FETCH_PHRASE = "取得";
/** Storyboard: the telop comes 1.0s after c2 starts. */
const TELOP_DELAY_SECONDS = 1;
const DOCK_FRAMES = CAMERA_FRAMES;
const UNDOCK_FRAMES = CAMERA_FRAMES;
/** The token stays docked at least this long, even on a short timeline. */
const MIN_DOCKED_FRAMES = 12;
const TELOP_LINE =
  "GitHub token は gh CLI が管理。repo-knowledge-mcp は受け取らず、保存もしません。";
const TELOP_LINES_STACKED = [
  "GitHub token は gh CLI が管理。",
  "repo-knowledge-mcp は受け取らず、保存もしません。",
];

type LocalLayout = {
  /** Along coordinate (station space) of the gh badge on the thread. */
  readonly badgeAlong: number;
  readonly flow: FetchFlowLayout;
  readonly store: StorePathLayout;
  /** Left-centre of the docked hero token (station space). */
  readonly dock: Point;
  readonly telop: Point;
  readonly telopLines: readonly string[];
};

const LOCAL_LAYOUTS: Readonly<Record<Orientation, LocalLayout>> = {
  landscape: {
    // On s02's first route stop ("gh CLI", x=640 in s02 space).
    badgeAlong: -1040,
    flow: {
      source: { x: 120, y: 403 },
      sourceSize: 40,
      from: { x: 400, y: 430 },
      to: { x: 820, y: 430 },
      badgeSize: 24,
    },
    store: {
      path: { x: 852, y: 392 },
      size: 56,
      elbow: { top: { x: 874, y: 474 }, end: { x: 910, y: 540 } },
    },
    dock: { x: 922, y: 540 },
    telop: { x: 120, y: 640 },
    telopLines: [TELOP_LINE],
  },
  portrait: {
    // Below the token when the move starts, so the token runs through it.
    badgeAlong: -80,
    flow: {
      source: { x: 156, y: 586 },
      sourceSize: 38,
      from: { x: 180, y: 652 },
      to: { x: 180, y: 800 },
      badgeSize: 26,
    },
    store: {
      path: { x: 156, y: 816 },
      size: 60,
      elbow: { top: { x: 180, y: 908 }, end: { x: 210, y: 982 } },
    },
    dock: { x: 222, y: 982 },
    telop: { x: 156, y: 1070 },
    telopLines: TELOP_LINES_STACKED,
  },
};

type LocalCues = FetchFlowCues & {
  readonly pathAt: number;
  readonly dockAt: number;
  readonly tagAt: number;
  readonly telopAt: number;
  readonly undockAt: number;
};

function localCues(time: SceneTime): LocalCues {
  const sourceAt = Math.max(time.arrival, time.cue("c1")) + ENTER_FRAMES / 2;
  const connectorAt = Math.max(
    sourceAt + STAGGER_FRAMES,
    time.phrase(GH_PHRASE),
  );
  const pulseAt = Math.max(
    connectorAt + ENTER_FRAMES,
    time.phrase(FETCH_PHRASE),
  );
  const pathAt = Math.max(fetchPulseEnd(pulseAt), time.cue("c2"));
  // Leave the dock so the token is back on the focus at the last frame.
  const undockAt = time.duration - 1 - UNDOCK_FRAMES;
  const dockAt = Math.min(
    pathAt + STAGGER_FRAMES,
    undockAt - DOCK_FRAMES - MIN_DOCKED_FRAMES,
  );
  return {
    sourceAt,
    connectorAt,
    pulseAt,
    pathAt,
    dockAt,
    tagAt: dockAt + DOCK_FRAMES,
    telopAt: time.cue("c2", secondsToFrames(TELOP_DELAY_SECONDS)),
    undockAt,
  };
}

function mixPoint(from: Point, to: Point, amount: number): Point {
  return { x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) };
}

/**
 * Focus → dock under the path (tracking the station while the camera
 * moves) → focus again. Frame 0 matches s02's end; the last frame matches
 * s04's start (outline + raw evidence tag on the focus).
 */
function DockingToken({
  dock,
  cues,
}: {
  dock: Point;
  cues: LocalCues;
}): ReactNode {
  const layout = useLayout();
  const { frame } = useSceneTime();
  const toScreen = useStationToScreen();
  const docking = progress(frame, cues.dockAt, DOCK_FRAMES, EASE_CAMERA);
  const leaving = progress(frame, cues.undockAt, UNDOCK_FRAMES, EASE_CAMERA);
  const docked = mixPoint(layout.focus, toScreen(dock), docking);
  return (
    <HeroToken
      position={mixPoint(docked, layout.focus, leaving)}
      tag={{ text: TOKEN_TAGS.rawEvidence, variant: "muted", at: cues.tagAt }}
    />
  );
}

export function S03Local({
  scene,
  orientation,
  stationIndex,
}: SceneProps): ReactNode {
  const time = useSceneTime();
  const local = LOCAL_LAYOUTS[orientation];
  const cues = localCues(time);
  return (
    <>
      <StationSpace>
        <ThreadBadge
          text={GH_BADGE}
          along={local.badgeAlong}
          station={stationIndex}
        />
        <Headline text={headlineOf(scene.id)} />
        <FetchFlow flow={local.flow} cues={cues} />
        <StorePathText layout={local.store} at={cues.pathAt} />
        <StoreElbow layout={local.store} at={cues.tagAt} />
        <SubTelop
          lines={local.telopLines}
          at={cues.telopAt}
          position={local.telop}
        />
      </StationSpace>
      <LeadInTokenCover />
      <DockingToken dock={local.dock} cues={cues} />
    </>
  );
}
