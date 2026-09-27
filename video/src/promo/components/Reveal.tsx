import type { CSSProperties, ReactNode } from "react";

import { useOrientation, useSceneTime } from "../context";
import { enterProgress, exitProgress, wipeMask } from "../motion";
import { ENTER_FRAMES, EXIT_FRAMES } from "../theme";

export type RevealProps = {
  /** Scene-relative frame at which the wipe starts. */
  at: number;
  /** Wipe length. Defaults to ENTER_FRAMES (16). */
  duration?: number;
  /** Scene-relative frame at which the exit wipe starts. None by default. */
  exitAt?: number;
  exitDuration?: number;
  /** Override the frame (for layers outside a scene). Scene frame otherwise. */
  frame?: number;
  /** Render as an inline-block (for words inside a line). */
  inline?: boolean;
  style?: CSSProperties;
  children: ReactNode;
};

/**
 * The only entrance in the promo: a feathered mask wipe in the thread
 * direction (left→right in 16:9, top→bottom in 9:16). No fade + rise.
 */
export function Reveal(props: RevealProps): ReactNode {
  const time = useSceneTime();
  return <RevealAt {...props} frame={props.frame ?? time.frame} />;
}

/** Same as Reveal but usable outside a scene: `frame` is required. */
export function RevealAt({
  at,
  duration = ENTER_FRAMES,
  exitAt,
  exitDuration = EXIT_FRAMES,
  frame,
  inline = false,
  style,
  children,
}: RevealProps & { frame: number }): ReactNode {
  const orientation = useOrientation();
  const enter = enterProgress(frame, at, duration);
  const exit = exitProgress(frame, exitAt, exitDuration);
  return (
    <div
      style={{
        display: inline ? "inline-block" : "block",
        ...style,
        ...wipeMask(orientation, enter, exit),
      }}
    >
      {children}
    </div>
  );
}
