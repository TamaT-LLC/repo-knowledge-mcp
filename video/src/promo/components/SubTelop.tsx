import type { ReactNode } from "react";

import { useLayout } from "../context";
import type { Point } from "../layout";
import { COLORS, STAGGER_FRAMES } from "../theme";
import { Reveal } from "./Reveal";
import { At } from "./Space";
import { BodyText } from "./Text";

/**
 * 小テロップ: a short muted statement in the scene (not a caption). Each
 * line is its own element and wipes in 3 frames after the previous one.
 * Place inside <StationSpace> so it flows away with the camera.
 */
export function SubTelop({
  lines,
  at,
  position,
  size,
}: {
  lines: readonly string[];
  at: number;
  position: Point;
  size?: number;
}): ReactNode {
  const layout = useLayout();
  return (
    <At x={position.x} y={position.y}>
      <BodyText
        size={size ?? layout.type.smallText}
        color={COLORS.muted}
        style={{ whiteSpace: "nowrap" }}
      >
        {lines.map((line, i) => (
          <Reveal key={line} at={at + i * STAGGER_FRAMES}>
            {line}
          </Reveal>
        ))}
      </BodyText>
    </At>
  );
}
