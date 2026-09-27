import type { CSSProperties, ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useLayout } from "../context";
import type { Point } from "../layout";
import { COLORS, LINE_HEIGHT } from "../theme";
import { Reveal } from "./Reveal";
import { CODE_STYLE } from "./Text";

const BADGE_PAD_CROSS_EM = 0.24;
const BADGE_PAD_ALONG_EM = 0.6;
const BADGE_RADIUS_EM = 0.38;
const CENTER = "translate(-50%, -50%)";

/** Badge padding along the text, exported for size estimates. */
export const CODE_BADGE_PAD_ALONG_EM = BADGE_PAD_ALONG_EM;
/** Badge height in em (text line + padding), exported for size estimates. */
export const CODE_BADGE_HEIGHT_EM = LINE_HEIGHT.tight + 2 * BADGE_PAD_CROSS_EM;

/**
 * Outlined code badge: 1px accent2 line, rounded corners, Space Grotesk.
 * The bg fill hides the thread behind it. `flash` (0–1) fills it with
 * accent2 and turns the text bg, for a one-shot "passed / fetched" blink.
 */
export function CodeBadge({
  text,
  flash = 0,
  size,
  style,
}: {
  text: string;
  flash?: number;
  size?: number;
  style?: CSSProperties;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        ...CODE_STYLE,
        display: "inline-block",
        padding: `${BADGE_PAD_CROSS_EM}em ${BADGE_PAD_ALONG_EM}em`,
        borderRadius: `${BADGE_RADIUS_EM}em`,
        border: `1px solid ${COLORS.accent2}`,
        background: interpolateColors(
          flash,
          [0, 1],
          [COLORS.bg, COLORS.accent2],
        ),
        color: interpolateColors(flash, [0, 1], [COLORS.accent2, COLORS.bg]),
        fontSize: size ?? layout.type.label,
        lineHeight: LINE_HEIGHT.tight,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {text}
    </div>
  );
}

/** A CodeBadge centred on `center`, wiping in at `at`. */
export function CenteredCodeBadge({
  center,
  at,
  exitAt,
  ...badge
}: {
  center: Point;
  at: number;
  exitAt?: number;
  text: string;
  flash?: number;
  size?: number;
}): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        left: center.x,
        top: center.y,
        transform: CENTER,
      }}
    >
      <Reveal at={at} exitAt={exitAt}>
        <CodeBadge {...badge} />
      </Reveal>
    </div>
  );
}
