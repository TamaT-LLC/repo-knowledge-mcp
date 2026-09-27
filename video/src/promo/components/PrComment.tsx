import type { ReactNode } from "react";

import { useLayout } from "../context";
import type { Orientation } from "../layout";
import { HERO_COMMENT, HERO_COMMENT_HEAD } from "../story";
import { COLORS } from "../theme";
import {
  cardCommentOrigin,
  cardCommentWidth,
  cardHeight,
  ReviewCard,
  type ReviewCardGeometry,
} from "./ReviewCard";
import { At } from "./Space";
import { BodyText } from "./Text";

// The review comment as it sits at the PR station (station 0), drawn as a
// pull-request review card. s01 types it; s07 can re-light it in the
// overview, where station 0 is back at its original screen position: render
// <PrCommentStatic /> inside <StationSpace station={0}>.

export const PR_EYEBROW = "PULL REQUEST · REVIEW COMMENT";

export type PrCommentLayout = {
  /** Top-left of the card header's text row (file path + eyebrow). */
  readonly eyebrow: { readonly x: number; readonly y: number };
  /** Top-left, wrap width and reserved lines of the comment text. */
  readonly comment: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly lines: number;
  };
  /** Landscape only: vertical drop from the card to the PR node. */
  readonly connectorX?: number;
  /** The whole review card (station space). */
  readonly card: ReviewCardGeometry;
};

const LANDSCAPE_CARD: ReviewCardGeometry = {
  x: 120,
  y: 330,
  width: 1680,
  padX: 36,
  headerHeight: 56,
  rowHeight: 34,
  rows: 2,
  diffPadY: 10,
  bodyPadTop: 22,
  authorHeight: 36,
  authorGap: 10,
  bodyPadBottom: 24,
  fontSize: 56,
  lines: 2,
  metaSize: 22,
  tail: "bottom-left",
};

// 9:16: the card starts just right of the vertical thread; its padding puts
// the comment text on the headline's x (156).
const PORTRAIT_CARD: ReviewCardGeometry = {
  x: 128,
  y: 588,
  width: 880,
  padX: 28,
  headerHeight: 56,
  rowHeight: 38,
  rows: 3,
  diffPadY: 10,
  bodyPadTop: 22,
  authorHeight: 36,
  authorGap: 12,
  bodyPadBottom: 28,
  fontSize: 48,
  lines: 3,
  metaSize: 22,
  tail: "top-left",
};

function layoutFromCard(
  card: ReviewCardGeometry,
  connectorX?: number,
): PrCommentLayout {
  const origin = cardCommentOrigin(card);
  return {
    eyebrow: { x: card.x + card.padX, y: card.y },
    comment: {
      x: origin.x,
      y: origin.y,
      width: cardCommentWidth(card),
      lines: card.lines,
    },
    connectorX,
    card,
  };
}

/** Station-space layout of the PR comment (s01 coordinates). */
export const PR_COMMENT_LAYOUTS: Readonly<
  Record<Orientation, PrCommentLayout>
> = {
  landscape: layoutFromCard(LANDSCAPE_CARD, LANDSCAPE_CARD.x),
  portrait: layoutFromCard(PORTRAIT_CARD),
};

/** Bottom edge (station space) of the comment block (the whole card). */
export function prCommentBottom(
  commentLayout: PrCommentLayout,
  fontSize = commentLayout.card.fontSize,
): number {
  const { card } = commentLayout;
  return card.y + cardHeight(card, fontSize);
}

export const HERO_COMMENT_HEAD_LENGTH = Array.from(HERO_COMMENT_HEAD).length;

/**
 * The full review card, without typing. `color` tints the comment body
 * (e.g. muted while dim, fg when re-lit); `headColor` tints the head words
 * that the hero token carries.
 */
export function PrCommentStatic({
  color = COLORS.fg,
  headColor = COLORS.accent2,
}: {
  color?: string;
  headColor?: string;
}): ReactNode {
  const layout = useLayout();
  const { card } = PR_COMMENT_LAYOUTS[layout.orientation];
  return (
    <At x={card.x} y={card.y}>
      <ReviewCard geometry={card} eyebrow={PR_EYEBROW}>
        <BodyText size={card.fontSize} color={color}>
          <span style={{ color: headColor }}>{HERO_COMMENT_HEAD}</span>
          {HERO_COMMENT.slice(HERO_COMMENT_HEAD.length)}
        </BodyText>
      </ReviewCard>
    </At>
  );
}
