import type { ReactNode } from "react";

import type { Point } from "../layout";
import { LINE_HEIGHT, SURFACE_COLORS } from "../theme";
import { Author, Diff, Header } from "./ReviewCardParts";

// A generic pull-request review comment: file header, a two- or three-line
// diff preview (abstract code bars, not real code) with the commented line
// highlighted, the reviewer row and the comment itself. No product logos and
// no real people: the reviewer is a generic silhouette. One corner is square
// so the card reads as a speech balloon whose tail is the thread connector.

export type ReviewCardGeometry = {
  /** Top-left of the card (station space) and its outer width. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly padX: number;
  readonly headerHeight: number;
  readonly rowHeight: number;
  /** Diff rows shown (the commented line is always the last one). */
  readonly rows: number;
  readonly diffPadY: number;
  readonly bodyPadTop: number;
  readonly authorHeight: number;
  readonly authorGap: number;
  readonly bodyPadBottom: number;
  /** Comment font size and the number of lines the card reserves. */
  readonly fontSize: number;
  readonly lines: number;
  /** Header and reviewer-row text size. */
  readonly metaSize: number;
  /** The square corner, pointing to where the thread connects. */
  readonly tail: "bottom-left" | "top-left";
};

const CORNER_PX = 16;

/** Station-space top-left of the comment text inside the card. */
export function cardCommentOrigin(geometry: ReviewCardGeometry): Point {
  const g = geometry;
  const diff = g.diffPadY * 2 + g.rows * g.rowHeight;
  return {
    x: g.x + g.padX,
    y:
      g.y + g.headerHeight + diff + g.bodyPadTop + g.authorHeight + g.authorGap,
  };
}

export function cardCommentWidth(geometry: ReviewCardGeometry): number {
  return geometry.width - geometry.padX * 2;
}

/** Outer height of the card for a comment size (defaults to its own). */
export function cardHeight(
  geometry: ReviewCardGeometry,
  fontSize = geometry.fontSize,
): number {
  const commentTop = cardCommentOrigin(geometry).y - geometry.y;
  const comment = geometry.lines * fontSize * LINE_HEIGHT.body;
  return commentTop + comment + geometry.bodyPadBottom;
}

function cornerRadius(tail: ReviewCardGeometry["tail"]): string {
  const r = `${CORNER_PX}px`;
  return tail === "bottom-left" ? `${r} ${r} ${r} 0` : `0 ${r} ${r} ${r}`;
}

/**
 * The card itself, in normal flow (position it with <At>). `children` is
 * the comment text, laid out at cardCommentOrigin() with the card's
 * comment width.
 */
export function ReviewCard({
  geometry,
  eyebrow,
  children,
}: {
  geometry: ReviewCardGeometry;
  eyebrow: string;
  children: ReactNode;
}): ReactNode {
  const radius = cornerRadius(geometry.tail);
  return (
    <div
      style={{
        position: "relative",
        width: geometry.width,
        height: cardHeight(geometry),
        borderRadius: radius,
        overflow: "hidden",
        background: SURFACE_COLORS.card,
      }}
    >
      <Header geometry={geometry} eyebrow={eyebrow} />
      <Diff geometry={geometry} />
      <div style={{ padding: `${geometry.bodyPadTop}px ${geometry.padX}px 0` }}>
        <Author geometry={geometry} />
        <div style={{ width: cardCommentWidth(geometry) }}>{children}</div>
      </div>
      {/* The outline sits on top so the header and diff fills never hide it. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: radius,
          boxShadow: `inset 0 0 0 1px ${SURFACE_COLORS.cardBorder}`,
        }}
      />
    </div>
  );
}
