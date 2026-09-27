import type { ReactNode } from "react";

import { useLayout, useSceneTime } from "../context";
import { COLORS, FONT_FAMILY, FONT_WEIGHT, LINE_HEIGHT } from "../theme";
import { Reveal } from "./Reveal";
import { ScreenSpace } from "./Space";

/**
 * 注記: the "説明用の例" disclaimer. Screen space, bottom-right in 16:9 and
 * bottom-left (above the SNS area) in 9:16. Exits at the camera departure.
 */
export function Note({
  text,
  at,
  exitAt,
}: {
  text: string;
  /** Scene-relative entrance frame. Defaults to the camera arrival. */
  at?: number;
  /** Scene-relative exit frame. Defaults to the camera departure. */
  exitAt?: number | null;
}): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const alignRight = layout.note.align === "right";
  return (
    <ScreenSpace>
      <div
        style={{
          position: "absolute",
          top: layout.note.y,
          left: alignRight ? undefined : layout.note.x,
          right: alignRight ? layout.width - layout.note.x : undefined,
          fontFamily: FONT_FAMILY,
          fontWeight: FONT_WEIGHT.regular,
          fontSize: layout.type.note,
          lineHeight: LINE_HEIGHT.caption,
          color: COLORS.muted,
          whiteSpace: "nowrap",
        }}
      >
        <Reveal
          at={at ?? time.arrival}
          exitAt={exitAt === null ? undefined : (exitAt ?? time.exitAt)}
        >
          {text}
        </Reveal>
      </div>
    </ScreenSpace>
  );
}
