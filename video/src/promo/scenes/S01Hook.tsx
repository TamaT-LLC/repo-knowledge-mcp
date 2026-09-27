import type { CSSProperties, ReactNode } from "react";
import { interpolateColors } from "remotion";

import { CONNECTOR_FRAMES, type HookTiming, hookTiming } from "../camera";
import { Headline } from "../components/Headline";
import { HeroToken } from "../components/HeroToken";
import { STATION_NODE_PX } from "../components/NodeRing";
import { Note } from "../components/Note";
import {
  HERO_COMMENT_HEAD_LENGTH,
  PR_COMMENT_LAYOUTS,
  PR_EYEBROW,
  type PrCommentLayout,
  prCommentBottom,
} from "../components/PrComment";
import { Reveal } from "../components/Reveal";
import { ReviewCard } from "../components/ReviewCard";
import { At, StationSpace } from "../components/Space";
import { BodyText } from "../components/Text";
import { Typewriter } from "../components/Typewriter";
import { useLayout, useSceneTime } from "../context";
import type { Layout } from "../layout";
import { progress } from "../motion";
import { HERO_COMMENT, headlineOf } from "../story";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  EASE_CAMERA,
  ENTER_FRAMES,
  LINE_HEIGHT,
  THREAD_STROKE_PX,
} from "../theme";
import type { SceneProps } from "./types";

// s01-hook: the review card wipes in, a caret blinks in it and the comment
// types itself; a connector ties the card to the thread and the thread runs
// toward the next station (the thread itself is the global World layer,
// timed by hookTiming()). The headline wipes in at c2. The comment's head
// then becomes the hero token.

const NOTE = "説明用の例（README のサンプル）";
/** The card wipes in right at the start (0.0s). */
const CARD_AT = 0;
/** The token appears this long after c2 starts… */
const TOKEN_AFTER_C2_FRAMES = 30;
/** …but always early enough to finish before the camera leaves. */
const TOKEN_LEAD_FRAMES = ENTER_FRAMES + 8;

function Comment({
  hook,
  timing,
  tokenAt,
}: {
  hook: PrCommentLayout;
  timing: HookTiming;
  tokenAt: number;
}): ReactNode {
  const { frame } = useSceneTime();
  // When the token is born, the head of the comment turns sky: the token
  // visibly "is" those words.
  const headColor = interpolateColors(
    progress(frame, tokenAt, COLOR_SHIFT_FRAMES),
    [0, 1],
    [COLORS.fg, COLORS.accent2],
  );
  const { card } = hook;
  return (
    <At x={card.x} y={card.y}>
      <Reveal at={CARD_AT}>
        <ReviewCard geometry={card} eyebrow={PR_EYEBROW}>
          <BodyText
            size={card.fontSize}
            style={{ lineHeight: LINE_HEIGHT.body }}
          >
            <Typewriter
              text={HERO_COMMENT}
              at={timing.typeStart}
              caretUntil={tokenAt}
              colorAt={(i) =>
                i < HERO_COMMENT_HEAD_LENGTH ? headColor : undefined
              }
            />
          </BodyText>
        </ReviewCard>
      </Reveal>
    </At>
  );
}

type ConnectorBox = {
  readonly style: CSSProperties;
  readonly at: number;
  readonly isVertical: boolean;
};

/**
 * The connector box: 16:9 drops from the card's square corner to the PR
 * node; 9:16 branches from the vertical thread into the card's square
 * corner once the thread has grown past it.
 */
function connectorBox(
  layout: Layout,
  hook: PrCommentLayout,
  timing: HookTiming,
): ConnectorBox {
  const half = THREAD_STROKE_PX / 2;
  if (hook.connectorX !== undefined) {
    const top = prCommentBottom(hook);
    const bottom = layout.threadCross - STATION_NODE_PX / 2;
    return {
      at: timing.connectorStart,
      isVertical: true,
      style: {
        left: hook.connectorX - half,
        top,
        width: THREAD_STROKE_PX,
        height: bottom - top,
        transformOrigin: "top",
      },
    };
  }
  const { card } = hook;
  const left = layout.threadCross;
  return {
    at: timing.threadStart,
    isVertical: false,
    style: {
      left,
      top: card.y + card.headerHeight / 2 - half,
      width: card.x - left,
      height: THREAD_STROKE_PX,
      transformOrigin: "left",
    },
  };
}

function Connector({
  hook,
  timing,
}: {
  hook: PrCommentLayout;
  timing: HookTiming;
}): ReactNode {
  const layout = useLayout();
  const { frame } = useSceneTime();
  const box = connectorBox(layout, hook, timing);
  const p = progress(frame, box.at, CONNECTOR_FRAMES, EASE_CAMERA);
  if (p <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        ...box.style,
        background: COLORS.threadLine,
        transform: box.isVertical ? `scaleY(${p})` : `scaleX(${p})`,
      }}
    />
  );
}

export function S01Hook({ scene, orientation }: SceneProps): ReactNode {
  const time = useSceneTime();
  const hook = PR_COMMENT_LAYOUTS[orientation];
  const timing = hookTiming(scene);
  const tokenAt = Math.min(
    time.cue("c2", TOKEN_AFTER_C2_FRAMES),
    time.departure - TOKEN_LEAD_FRAMES,
  );
  return (
    <>
      <StationSpace>
        <Connector hook={hook} timing={timing} />
        <Comment hook={hook} timing={timing} tokenAt={tokenAt} />
        <Headline text={headlineOf(scene.id)} at={time.cue("c2")} />
      </StationSpace>
      <HeroToken enterAt={tokenAt} />
      <Note text={NOTE} at={timing.typeEnd} />
    </>
  );
}
