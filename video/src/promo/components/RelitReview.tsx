import type { ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useLayout, useSceneTime } from "../context";
import { progress } from "../motion";
import { HERO_COMMENT, HERO_COMMENT_HEAD } from "../story";
import { COLOR_SHIFT_FRAMES, COLORS } from "../theme";
import { ThreadBranch } from "./Connector";
import { STATION_NODE_PX } from "./NodeRing";
import {
  PR_COMMENT_LAYOUTS,
  PrCommentStatic,
  prCommentBottom,
} from "./PrComment";
import { Reveal } from "./Reveal";
import { At, StationSpace } from "./Space";
import { BodyText } from "./Text";

// s07 overview: the original review comment at the PR station, dim at first
// and lit again when the light that ran back along the thread reaches PR.
// It lives in station 0's space, so it slides in with the world as the
// overview morph brings the PR station on screen.
//
// Landscape shows the review card exactly where s01 typed it, joined to the
// PR node by the s01 connector (the balloon's tail). In the portrait
// overview the station labels are stacked where the s01 card was, so a
// compact copy of the comment sits on the PR label's row instead.

/** Portrait: compact comment beside the "PR" station label. */
const COMPACT_COMMENT = { x: 190, y: 279, width: 818 } as const;

type Tint = { readonly body: string; readonly head: string };

function useTint(litAt: number): Tint {
  const { frame } = useSceneTime();
  const lit = progress(frame, litAt, COLOR_SHIFT_FRAMES);
  return {
    body: interpolateColors(lit, [0, 1], [COLORS.muted, COLORS.fg]),
    head: interpolateColors(lit, [0, 1], [COLORS.muted, COLORS.accent2]),
  };
}

function LandscapeComment({
  at,
  litAt,
  exitAt,
}: {
  at: number;
  litAt: number;
  exitAt?: number;
}): ReactNode {
  const tint = useTint(litAt);
  const commentLayout = PR_COMMENT_LAYOUTS.landscape;
  return (
    <>
      <Reveal
        at={at}
        exitAt={exitAt}
        style={{ position: "absolute", inset: 0 }}
      >
        <PrCommentStatic color={tint.body} headColor={tint.head} />
      </Reveal>
      {commentLayout.connectorX === undefined ? null : (
        <ThreadBranch
          along={commentLayout.connectorX}
          cross={prCommentBottom(commentLayout)}
          at={litAt}
          ringSize={STATION_NODE_PX}
          exitAt={exitAt}
        />
      )}
    </>
  );
}

function CompactComment({
  at,
  litAt,
  exitAt,
}: {
  at: number;
  litAt: number;
  exitAt?: number;
}): ReactNode {
  const layout = useLayout();
  const tint = useTint(litAt);
  return (
    <At
      x={COMPACT_COMMENT.x}
      y={COMPACT_COMMENT.y}
      width={COMPACT_COMMENT.width}
    >
      <Reveal at={at} exitAt={exitAt}>
        <BodyText size={layout.type.smallText} color={tint.body}>
          <span style={{ color: tint.head }}>{HERO_COMMENT_HEAD}</span>
          {HERO_COMMENT.slice(HERO_COMMENT_HEAD.length)}
        </BodyText>
      </Reveal>
    </At>
  );
}

export function RelitReview({
  station,
  at,
  litAt,
  exitAt,
}: {
  /** Index of the PR station. */
  station: number;
  /** Scene-relative frame the (dim) comment wipes in. */
  at: number;
  /** Scene-relative frame the returning light reaches PR. */
  litAt: number;
  exitAt?: number;
}): ReactNode {
  const layout = useLayout();
  return (
    <StationSpace station={station}>
      {layout.orientation === "landscape" ? (
        <LandscapeComment at={at} litAt={litAt} exitAt={exitAt} />
      ) : (
        <CompactComment at={at} litAt={litAt} exitAt={exitAt} />
      )}
    </StationSpace>
  );
}
