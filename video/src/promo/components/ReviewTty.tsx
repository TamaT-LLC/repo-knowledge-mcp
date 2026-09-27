import type { ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useSceneTime } from "../context";
import type { Rect } from "../layout";
import { progress } from "../motion";
import { HERO_COMMENT_HEAD, HERO_RULE } from "../story";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  STAGGER_FRAMES,
  withAlpha,
} from "../theme";
import { type PulseShape, pulseOnce } from "./pulseOnce";
import { Reveal } from "./Reveal";
import { LINE_GAP_EM, TerminalFrame, TerminalLine } from "./TerminalFrame";
import { Prompt, Sym } from "./Text";
import { Typewriter } from "./Typewriter";

// s05: the human review in a real TTY (simplified). The command types in,
// then the candidate, its evidence and the two choices appear. At 「根拠」
// the evidence row is highlighted once; at c3 the cursor lands on approve
// and it is confirmed in vermilion (the human's decision).

export const REVIEW_COMMAND = "repo-knowledge review";
export const REVIEW_TARGET = "owner/repository";
const EVIDENCE_KEY = "evidence";
const EVIDENCE_VALUE = "review comment · Pull Request";
const APPROVE = "approve";
const REJECT = "reject";
const CURSOR = "›";
/** Total gap wanted between groups of rows (command / candidate / evidence /
 * choice). TerminalFrame already puts LINE_GAP_EM between every row, so only
 * the remainder is added as margin on the row that starts a new group. */
const GROUP_GAP_EM = 0.55;
const GROUP_EXTRA_GAP_EM = GROUP_GAP_EM - LINE_GAP_EM;
const CHIP_PAD_CROSS_EM = 0.14;
const CHIP_PAD_ALONG_EM = 0.6;
const CHIP_RADIUS_EM = 0.3;
const CHIP_GAP_EM = 0.6;
const HIGHLIGHT_ALPHA = 0.14;
const HIGHLIGHT_PAD_EM = 0.3;
const EVIDENCE_PULSE: PulseShape = { rise: 6, hold: 20, fall: 14 };
/** The cursor wipes onto approve quickly (it is a keypress, not a reveal). */
const CURSOR_WIPE_FRAMES = 6;

export type ReviewTtyLayout = {
  readonly box: Rect;
  readonly size: number;
  /**
   * 9:16: "owner/repository" goes on a second command line, and the
   * candidate breaks before "strict schema" instead of inside it.
   */
  readonly split: boolean;
};

/** The candidate breaks here in 9:16 (keeps "strict schema" together). */
const CANDIDATE_BREAK = "strict schema";

function candidateLines(split: boolean): readonly string[] {
  const at = HERO_RULE.indexOf(CANDIDATE_BREAK);
  if (!split || at <= 0) return [HERO_RULE];
  return [HERO_RULE.slice(0, at).trimEnd(), HERO_RULE.slice(at)];
}

export type ReviewTtyCues = {
  readonly frameAt: number;
  readonly commandAt: number;
  readonly outputAt: number;
  readonly evidenceAt: number;
  readonly cursorAt: number;
  readonly confirmAt: number;
};

/** Frames needed to type the command, for scheduling the output rows. */
export function reviewCommandFrames(): number {
  return Array.from(`${REVIEW_COMMAND} ${REVIEW_TARGET}`).length;
}

const commandColor = (i: number): string =>
  i < REVIEW_COMMAND.length ? COLORS.accent2 : COLORS.fg;

function CommandLines({
  tty,
  cues,
}: {
  tty: ReviewTtyLayout;
  cues: ReviewTtyCues;
}): ReactNode {
  if (!tty.split) {
    return (
      <TerminalLine at={cues.frameAt} prompt="$" size={tty.size}>
        <Typewriter
          text={`${REVIEW_COMMAND} ${REVIEW_TARGET}`}
          at={cues.commandAt}
          caretUntil={cues.outputAt}
          colorAt={commandColor}
        />
      </TerminalLine>
    );
  }
  const secondAt = cues.commandAt + Array.from(`${REVIEW_COMMAND} `).length;
  return (
    <>
      <TerminalLine at={cues.frameAt} prompt="$" size={tty.size}>
        <Typewriter
          text={REVIEW_COMMAND}
          at={cues.commandAt}
          caretUntil={secondAt}
          style={{ color: COLORS.accent2 }}
        />
      </TerminalLine>
      <TerminalLine at={cues.frameAt} size={tty.size}>
        <span style={{ visibility: "hidden" }}>
          <Prompt />
        </span>
        <Typewriter
          text={REVIEW_TARGET}
          at={secondAt}
          caretUntil={cues.outputAt}
        />
      </TerminalLine>
    </>
  );
}

function EvidenceLine({
  tty,
  cues,
}: {
  tty: ReviewTtyLayout;
  cues: ReviewTtyCues;
}): ReactNode {
  const { frame } = useSceneTime();
  const lit = pulseOnce(frame, cues.evidenceAt, EVIDENCE_PULSE);
  return (
    <TerminalLine
      at={cues.outputAt + STAGGER_FRAMES}
      size={tty.size}
      style={{
        margin: `0 -${HIGHLIGHT_PAD_EM}em`,
        padding: `0 ${HIGHLIGHT_PAD_EM}em`,
        borderRadius: `${CHIP_RADIUS_EM}em`,
        background: withAlpha(COLORS.accent2, HIGHLIGHT_ALPHA * lit),
      }}
    >
      <span style={{ color: COLORS.accent2 }}>{EVIDENCE_KEY}</span>
      <Sym>: </Sym>
      <span
        style={{
          color: interpolateColors(lit, [0, 1], [COLORS.muted, COLORS.fg]),
        }}
      >
        {EVIDENCE_VALUE}
      </span>
    </TerminalLine>
  );
}

function Chip({
  text,
  confirmed,
}: {
  text: string;
  confirmed: number;
}): ReactNode {
  return (
    <span
      style={{
        display: "inline-block",
        padding: `${CHIP_PAD_CROSS_EM}em ${CHIP_PAD_ALONG_EM}em`,
        marginRight: `${CHIP_GAP_EM}em`,
        borderRadius: `${CHIP_RADIUS_EM}em`,
        border: `1px solid ${interpolateColors(confirmed, [0, 1], [COLORS.hairlineStrong, COLORS.accent])}`,
        background: interpolateColors(
          confirmed,
          [0, 1],
          [withAlpha(COLORS.accent, 0), COLORS.accent],
        ),
        color: interpolateColors(confirmed, [0, 1], [COLORS.muted, COLORS.bg]),
      }}
    >
      {text}
    </span>
  );
}

function ChoiceLine({
  tty,
  cues,
}: {
  tty: ReviewTtyLayout;
  cues: ReviewTtyCues;
}): ReactNode {
  const { frame } = useSceneTime();
  const confirmed = progress(frame, cues.confirmAt, COLOR_SHIFT_FRAMES);
  return (
    <TerminalLine
      at={cues.outputAt + 2 * STAGGER_FRAMES}
      size={tty.size}
      style={{ marginTop: `${GROUP_EXTRA_GAP_EM}em` }}
    >
      <span style={{ display: "inline-block", minWidth: "1em" }}>
        <TerminalCursor at={cues.cursorAt} />
      </span>
      <Chip text={APPROVE} confirmed={confirmed} />
      <Chip text={REJECT} confirmed={0} />
    </TerminalLine>
  );
}

function TerminalCursor({ at }: { at: number }): ReactNode {
  return (
    <Reveal at={at} duration={CURSOR_WIPE_FRAMES} inline>
      <span style={{ color: COLORS.fg }}>{CURSOR}</span>
    </Reveal>
  );
}

/** The whole TTY frame. Place inside <StationSpace>. */
export function ReviewTty({
  tty,
  cues,
}: {
  tty: ReviewTtyLayout;
  cues: ReviewTtyCues;
}): ReactNode {
  const head = HERO_COMMENT_HEAD;
  const [first, ...rest] = candidateLines(tty.split);
  return (
    <div style={{ position: "absolute", left: tty.box.x, top: tty.box.y }}>
      <TerminalFrame
        at={cues.frameAt}
        width={tty.box.width}
        height={tty.box.height}
        fontSize={tty.size}
      >
        <CommandLines tty={tty} cues={cues} />
        <TerminalLine
          at={cues.outputAt}
          size={tty.size}
          style={{ marginTop: `${GROUP_EXTRA_GAP_EM}em` }}
        >
          <span style={{ color: COLORS.accent2 }}>{head}</span>
          {first.slice(head.length)}
          {rest.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TerminalLine>
        <EvidenceLine tty={tty} cues={cues} />
        <ChoiceLine tty={tty} cues={cues} />
      </TerminalFrame>
    </div>
  );
}
