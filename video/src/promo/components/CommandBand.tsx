import type { ReactNode } from "react";

import { useSceneTime } from "../context";
import type { Orientation } from "../layout";
import { enterProgress } from "../motion";
import { COLORS, LINE_HEIGHT, THREAD_STROKE_PX } from "../theme";
import { Reveal } from "./Reveal";
import { CODE_STYLE, Prompt, Sym } from "./Text";
import { Caret } from "./Typewriter";

// The CTA command band (s08). The thread reaches the band's left edge, so
// the band has no left border: the 2px rail drawn by the scene is its edge.
// Portrait breaks the command with shell line continuations ("\") so it is
// still valid when copied.

const NPX = "npx -y";
const PACKAGE = "@tamat-llc/repo-knowledge-mcp@latest";
const SUBCOMMAND = "setup";
const CONTINUATION = "\\";
const BAND_RADIUS_PX = 14;
const BORDER_PX = 1;
const FULL_PERCENT = 100;
/** Distance of the setup underline below the text's line box. */
const UNDERLINE_DROP_EM = 0.02;

export type CommandBandSpec = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly size: number;
  readonly padLeft: number;
  readonly padRight: number;
  readonly padY: number;
};

/** Number of command lines per orientation (1 or 3). */
export function commandLineCount(orientation: Orientation): number {
  return orientation === "landscape" ? 1 : 3;
}

export function commandBandHeight(
  spec: CommandBandSpec,
  orientation: Orientation,
): number {
  const lines = commandLineCount(orientation);
  return lines * spec.size * LINE_HEIGHT.code + 2 * (spec.padY + BORDER_PX);
}

function Setup({ underlineAt }: { underlineAt: number }): ReactNode {
  const { frame } = useSceneTime();
  const drawn = enterProgress(frame, underlineAt);
  return (
    <>
      <span style={{ position: "relative", color: COLORS.accent2 }}>
        {SUBCOMMAND}
        <span
          style={{
            position: "absolute",
            left: 0,
            bottom: `-${UNDERLINE_DROP_EM}em`,
            width: `${drawn * FULL_PERCENT}%`,
            height: THREAD_STROKE_PX,
            background: COLORS.accent2,
          }}
        />
      </span>
      <Caret frame={frame} />
    </>
  );
}

function CommandLines({
  orientation,
  underlineAt,
}: {
  orientation: Orientation;
  underlineAt: number;
}): ReactNode {
  const prompt = <Prompt symbol="$" color={COLORS.accent2} />;
  const setup = <Setup underlineAt={underlineAt} />;
  if (orientation === "landscape") {
    return (
      <div>
        {prompt}
        {`${NPX} ${PACKAGE} `}
        {setup}
      </div>
    );
  }
  return (
    <>
      <div>
        {prompt}
        {`${NPX} `}
        <Sym>{CONTINUATION}</Sym>
      </div>
      <div>
        {`${PACKAGE} `}
        <Sym>{CONTINUATION}</Sym>
      </div>
      <div>{setup}</div>
    </>
  );
}

export function CommandBand({
  spec,
  orientation,
  at,
  underlineAt,
}: {
  spec: CommandBandSpec;
  orientation: Orientation;
  at: number;
  underlineAt: number;
}): ReactNode {
  const border = `${BORDER_PX}px solid ${COLORS.hairlineStrong}`;
  return (
    <div
      style={{
        position: "absolute",
        left: spec.x,
        top: spec.y,
        width: spec.width,
      }}
    >
      <Reveal at={at}>
        <div
          style={{
            ...CODE_STYLE,
            boxSizing: "border-box",
            height: commandBandHeight(spec, orientation),
            padding: `${spec.padY}px ${spec.padRight}px ${spec.padY}px ${spec.padLeft}px`,
            fontSize: spec.size,
            color: COLORS.fg,
            whiteSpace: "nowrap",
            background: COLORS.panel,
            borderTop: border,
            borderRight: border,
            borderBottom: border,
            borderRadius: `0 ${BAND_RADIUS_PX}px ${BAND_RADIUS_PX}px 0`,
          }}
        >
          <CommandLines orientation={orientation} underlineAt={underlineAt} />
        </div>
      </Reveal>
    </div>
  );
}
