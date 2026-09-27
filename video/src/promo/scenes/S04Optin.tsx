import type { ReactNode } from "react";

import {
  ClickPointer,
  POINTER_APPEAR_FRAMES,
} from "../components/ClickPointer";
import {
  checkedMorphRows,
  DiffMorph,
  type MorphRow,
  type MorphSchedule,
  morphRowHeight,
  morphSchedule,
} from "../components/DiffMorph";
import { Headline } from "../components/Headline";
import { StateTag } from "../components/HeroToken";
import { HeroTokenSwap, heroTokenSwapEnd } from "../components/HeroTokenSwap";
import { Note } from "../components/Note";
import {
  OptinList,
  type OptinListLayout,
  optinToggleCenter,
} from "../components/OptinList";
import { Reveal } from "../components/Reveal";
import { At, StationSpace } from "../components/Space";
import { BodyText, Label } from "../components/Text";
import { type SceneTime, useLayout, useSceneTime } from "../context";
import type { Orientation, Point } from "../layout";
import {
  HERO_COMMENT,
  HERO_COMMENT_HEAD,
  HERO_RULE,
  headlineOf,
  TOKEN_TAGS,
} from "../story";
import { COLOR_SHIFT_FRAMES, ENTER_FRAMES, STAGGER_FRAMES } from "../theme";
import { secondsToFrames } from "../timeline";
import type { SceneProps } from "./types";

// s04-optin: the "外部送信" list with every method OFF. The review comment
// waits beside it, dim. At 「許可した」 the pointer switches ON one
// distillation path (vermilion: the human decides), the comment lights up
// and morphs character by character into the rule candidate, which gets
// the proposed tag (and so does the hero token). At c3 the rows that stayed
// OFF brighten their "既定：無効" once.

const NOTE = "説明用の例";
const DISTILL_LABEL = "distill（蒸留）";
const PERMIT_PHRASE = "許可した";
/** Storyboard: the OFF rows brighten 0.5s after c3 starts. */
const PULSE_AFTER_C3_SECONDS = 0.5;
/** Methods that can send data out (README "privacy と信頼設定"). */
const METHODS = [
  "Provider Adapter",
  "host-assisted distillation",
  "Jev merge classification",
] as const;
/** A distillation path (Jev only classifies merges). */
const ON_INDEX = 1;
const MIN_POINTER_TRAVEL_FRAMES = 10;
const POINTER_LINGER_FRAMES = 14;
/** The lit comment is readable for a beat before it starts to morph. */
const MORPH_DELAY_FRAMES = COLOR_SHIFT_FRAMES;

/** Comment → rule, as explicit lines (no reflow while morphing). */
const MORPH_ROWS: readonly MorphRow[] = checkedMorphRows(
  [
    [
      { kind: "keep", text: "GitHub API の応答は、" },
      { kind: "del", text: "保存" },
      { kind: "add", text: "永続化" },
      { kind: "keep", text: "する前に " },
    ],
    [
      { kind: "keep", text: "strict schema で検証" },
      { kind: "del", text: "し、未知 " },
      { kind: "add", text: "する" },
    ],
    [{ kind: "del", text: "key を拒否してください。" }],
  ],
  HERO_COMMENT,
  HERO_RULE,
);
const HEAD_LENGTH = Array.from(HERO_COMMENT_HEAD).length;
/** Row that is empty after the morph; the proposed tag takes its place. */
const TAG_ROW = MORPH_ROWS.length - 1;

type MorphLayout = {
  readonly x: number;
  readonly eyebrowY: number;
  readonly top: number;
  readonly size: number;
};

type OptinLayout = {
  readonly list: OptinListLayout;
  readonly morph: MorphLayout;
  /** Where the pointer appears, relative to the toggle it will press. */
  readonly pointerOffset: Point;
};

const OPTIN_LAYOUTS: Readonly<Record<Orientation, OptinLayout>> = {
  landscape: {
    list: {
      x: 120,
      width: 720,
      labelY: 336,
      top: 372,
      rowHeight: 84,
      stacked: false,
      nameSize: 32,
      valueSize: 24,
    },
    // Right edge of the longest row stays within x≤1680, so the block can
    // simply flow away with the camera.
    morph: { x: 904, eyebrowY: 336, top: 372, size: 44 },
    pointerOffset: { x: 200, y: 170 },
  },
  portrait: {
    list: {
      x: 156,
      width: 852,
      labelY: 572,
      top: 606,
      rowHeight: 100,
      stacked: true,
      nameSize: 34,
      valueSize: 24,
    },
    morph: { x: 156, eyebrowY: 940, top: 976, size: 44 },
    pointerOffset: { x: -180, y: 150 },
  },
};

type OptinCues = {
  readonly listAt: number;
  readonly commentAt: number;
  readonly pointerAt: number;
  readonly clickAt: number;
  readonly activateAt: number;
  readonly morph: MorphSchedule;
  readonly tagAt: number;
  readonly pulseAt: number;
};

function optinCues(time: SceneTime): OptinCues {
  const listAt = time.arrival + ENTER_FRAMES / 2;
  const commentAt = listAt + (METHODS.length + 1) * STAGGER_FRAMES;
  const pointerAt = Math.max(commentAt + ENTER_FRAMES, time.cue("c2"));
  const clickAt = Math.max(
    pointerAt + POINTER_APPEAR_FRAMES + MIN_POINTER_TRAVEL_FRAMES,
    time.phrase(PERMIT_PHRASE),
  );
  const activateAt = clickAt + COLOR_SHIFT_FRAMES;
  const morph = morphSchedule(activateAt + MORPH_DELAY_FRAMES, MORPH_ROWS);
  const tagAt = morph.doneAt + STAGGER_FRAMES;
  return {
    listAt,
    commentAt,
    pointerAt,
    clickAt,
    activateAt,
    morph,
    tagAt,
    pulseAt: Math.max(
      time.cue("c3", secondsToFrames(PULSE_AFTER_C3_SECONDS)),
      tagAt + ENTER_FRAMES,
    ),
  };
}

function DistillBlock({
  morph,
  cues,
}: {
  morph: MorphLayout;
  cues: OptinCues;
}): ReactNode {
  const layout = useLayout();
  const rowHeight = morphRowHeight(morph.size);
  return (
    <>
      <At x={morph.x} y={morph.eyebrowY}>
        <Reveal at={cues.activateAt}>
          <Label uppercase={false}>{DISTILL_LABEL}</Label>
        </Reveal>
      </At>
      <At x={morph.x} y={morph.top}>
        <Reveal at={cues.commentAt}>
          <BodyText size={morph.size}>
            <DiffMorph
              rows={MORPH_ROWS}
              schedule={cues.morph}
              size={morph.size}
              activateAt={cues.activateAt}
              headLength={HEAD_LENGTH}
            />
          </BodyText>
        </Reveal>
      </At>
      <At x={morph.x} y={morph.top + TAG_ROW * rowHeight}>
        <div
          style={{ height: rowHeight, display: "flex", alignItems: "center" }}
        >
          <Reveal at={cues.tagAt}>
            <StateTag
              text={TOKEN_TAGS.proposed}
              variant="sky"
              size={layout.type.token}
            />
          </Reveal>
        </div>
      </At>
    </>
  );
}

export function S04Optin({ scene, orientation }: SceneProps): ReactNode {
  const time = useSceneTime();
  const optin = OPTIN_LAYOUTS[orientation];
  const cues = optinCues(time);
  const toggle = optinToggleCenter(optin.list, ON_INDEX);
  const swapAt = Math.min(
    cues.tagAt,
    time.duration - 1 - (heroTokenSwapEnd(0) + STAGGER_FRAMES),
  );
  return (
    <>
      <StationSpace>
        <Headline text={headlineOf(scene.id)} />
        <OptinList
          list={optin.list}
          methods={METHODS}
          onIndex={ON_INDEX}
          cues={{ at: cues.listAt, onAt: cues.clickAt, pulseAt: cues.pulseAt }}
        />
        <DistillBlock morph={optin.morph} cues={cues} />
        <ClickPointer
          from={{
            x: toggle.x + optin.pointerOffset.x,
            y: toggle.y + optin.pointerOffset.y,
          }}
          to={toggle}
          at={cues.pointerAt}
          clickAt={cues.clickAt}
          exitAt={cues.clickAt + POINTER_LINGER_FRAMES}
        />
      </StationSpace>
      <HeroTokenSwap
        from={{ tag: { text: TOKEN_TAGS.rawEvidence, variant: "muted" } }}
        to={{ tag: { text: TOKEN_TAGS.proposed, variant: "sky" } }}
        at={swapAt}
      />
      <Note text={NOTE} at={cues.commentAt} />
    </>
  );
}
