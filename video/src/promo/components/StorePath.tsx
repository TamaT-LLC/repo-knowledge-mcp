import type { ReactNode } from "react";

import type { Point } from "../layout";
import { COLORS, THREAD_STROKE_PX } from "../theme";
import { Reveal } from "./Reveal";
import { At } from "./Space";
import { Code } from "./Text";

// s03: the local store path "~/.repo-knowledge/" (only "~/" in accent2) and
// the file-tree elbow that hangs the docked hero token under it.

const PATH_HOME = "~/";
const PATH_REST = ".repo-knowledge/";
/** Stroke padding so the elbow's corners are not clipped by its box. */
const ELBOW_PAD_PX = THREAD_STROKE_PX;

export type StorePathLayout = {
  /** Top-left of the path text, and its size. */
  readonly path: Point;
  readonly size: number;
  /** File-tree elbow: down from `top`, then along to `end`. */
  readonly elbow: { readonly top: Point; readonly end: Point };
};

/** The path text. Place inside <StationSpace>. */
export function StorePathText({
  layout,
  at,
}: {
  layout: StorePathLayout;
  at: number;
}): ReactNode {
  return (
    <At x={layout.path.x} y={layout.path.y}>
      <Reveal at={at}>
        <Code size={layout.size} style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: COLORS.accent2 }}>{PATH_HOME}</span>
          {PATH_REST}
        </Code>
      </Reveal>
    </At>
  );
}

/** "└─" elbow from under the path to the docked token (muted symbol). */
export function StoreElbow({
  layout,
  at,
}: {
  layout: StorePathLayout;
  at: number;
}): ReactNode {
  const { top, end } = layout.elbow;
  const left = top.x - ELBOW_PAD_PX;
  const upper = top.y - ELBOW_PAD_PX;
  const width = end.x - top.x + 2 * ELBOW_PAD_PX;
  const height = end.y - top.y + 2 * ELBOW_PAD_PX;
  const points = [
    `${ELBOW_PAD_PX},${ELBOW_PAD_PX}`,
    `${ELBOW_PAD_PX},${height - ELBOW_PAD_PX}`,
    `${width - ELBOW_PAD_PX},${height - ELBOW_PAD_PX}`,
  ].join(" ");
  return (
    <Reveal
      at={at}
      style={{ position: "absolute", left, top: upper, width, height }}
    >
      <svg width={width} height={height} aria-hidden="true">
        <polyline
          points={points}
          fill="none"
          stroke={COLORS.muted}
          strokeWidth={THREAD_STROKE_PX}
          strokeLinejoin="round"
        />
      </svg>
    </Reveal>
  );
}
