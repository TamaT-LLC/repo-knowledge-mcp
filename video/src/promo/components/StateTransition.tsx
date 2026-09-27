import type { ReactNode } from "react";

import type { Point } from "../layout";
import { TOKEN_TAGS } from "../story";
import { COLORS, STAGGER_FRAMES } from "../theme";
import { StateTag, type TagVariant } from "./HeroToken";
import { Reveal } from "./Reveal";
import { At } from "./Space";

// s05: "proposed → active". Both states are listed from the start; at the
// switch, active fills with accent2 and proposed dims, each by a wipe of the
// new look over the old one (same text, same box), never by a cut.

const ARROW_DOWN = "↓";
const ARROW_RIGHT = "→";
const GAP_EM = 0.5;
/** Centres the down arrow under the tag text in the vertical layout. */
const ARROW_INDENT_EM = 0.9;

/** A tag whose look is wiped over by another variant at `switchAt`. */
function SwitchingTag({
  text,
  before,
  after,
  switchAt,
  size,
}: {
  text: string;
  before: TagVariant;
  after: TagVariant;
  switchAt: number;
  size: number;
}): ReactNode {
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <StateTag text={text} variant={before} size={size} />
      <Reveal at={switchAt} style={{ position: "absolute", left: 0, top: 0 }}>
        <StateTag text={text} variant={after} size={size} />
      </Reveal>
    </div>
  );
}

export function StateTransition({
  position,
  vertical,
  at,
  switchAt,
  size,
}: {
  /** Top-left of the group (station space). */
  position: Point;
  /** Stack top→bottom (16:9 column) instead of left→right (9:16 row). */
  vertical: boolean;
  at: number;
  switchAt: number;
  /** Tag text size. */
  size: number;
}): ReactNode {
  return (
    <At x={position.x} y={position.y}>
      <div
        style={{
          display: "flex",
          flexDirection: vertical ? "column" : "row",
          alignItems: vertical ? "flex-start" : "center",
          gap: `${GAP_EM}em`,
          fontSize: size,
        }}
      >
        <Reveal at={at}>
          <SwitchingTag
            text={TOKEN_TAGS.proposed}
            before="sky"
            after="muted"
            switchAt={switchAt}
            size={size}
          />
        </Reveal>
        <Reveal at={at + STAGGER_FRAMES}>
          <span
            style={{
              color: COLORS.muted,
              paddingLeft: vertical ? `${ARROW_INDENT_EM}em` : 0,
            }}
          >
            {vertical ? ARROW_DOWN : ARROW_RIGHT}
          </span>
        </Reveal>
        <Reveal at={at + 2 * STAGGER_FRAMES}>
          <SwitchingTag
            text={TOKEN_TAGS.active}
            before="muted"
            after="active"
            switchAt={switchAt}
            size={size}
          />
        </Reveal>
      </div>
    </At>
  );
}
