import type { ReactNode } from "react";

import { useSceneTime } from "../context";
import type { Point } from "../layout";
import { mix, progress } from "../motion";
import { EASE_CAMERA } from "../theme";
import { POINTER_PX, Pointer } from "./Pointer";
import { type PulseShape, pulseOnce } from "./pulseOnce";
import { Reveal } from "./Reveal";

// A pointer that wipes in at `from`, glides to `to`, presses once at
// `clickAt` and wipes out at `exitAt`. Station space.

/** Extra room around the pointer glyph for its outline. */
const POINTER_MASK_PADDING_PX = 8;
/** Mask box around the pointer glyph (plus its outline). */
const POINTER_BOX_PX = POINTER_PX + POINTER_MASK_PADDING_PX;
/** Short wipe: the pointer is small and should not linger half-drawn. */
const POINTER_WIPE_FRAMES = 6;
const PRESS: PulseShape = { rise: 2, hold: 1, fall: 5 };

/** Frames the pointer needs between appearing and starting to move. */
export const POINTER_APPEAR_FRAMES = POINTER_WIPE_FRAMES;

export function ClickPointer({
  from,
  to,
  at,
  clickAt,
  exitAt,
}: {
  from: Point;
  to: Point;
  /** Scene-relative frame the pointer wipes in (at `from`). */
  at: number;
  /** The tip reaches `to` and presses. */
  clickAt: number;
  exitAt: number;
}): ReactNode {
  const { frame } = useSceneTime();
  const moveAt = at + POINTER_WIPE_FRAMES;
  const travel = progress(frame, moveAt, clickAt - moveAt, EASE_CAMERA);
  const tip = { x: mix(from.x, to.x, travel), y: mix(from.y, to.y, travel) };
  return (
    <Reveal
      at={at}
      duration={POINTER_WIPE_FRAMES}
      exitAt={exitAt}
      style={{
        position: "absolute",
        left: tip.x,
        top: tip.y,
        width: POINTER_BOX_PX,
        height: POINTER_BOX_PX,
      }}
    >
      <Pointer
        tip={{ x: 0, y: 0 }}
        pressed={pulseOnce(frame, clickAt - PRESS.rise, PRESS)}
      />
    </Reveal>
  );
}
