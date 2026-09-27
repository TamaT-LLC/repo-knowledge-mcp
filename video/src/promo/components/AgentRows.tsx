import type { ReactNode } from "react";

import { type SceneTime, useLayout, useSceneTime } from "../context";
import type { Layout, Orientation } from "../layout";
import { progress } from "../motion";
import {
  COLORS,
  EASE_EXIT,
  LINE_HEIGHT,
  OVERVIEW_MORPH_FRAMES,
  STAGGER_FRAMES,
} from "../theme";
import { Reveal } from "./Reveal";
import { ruleLines } from "./RulesData";
import { At } from "./Space";
import { BodyText, CODE_STYLE, Hairline } from "./Text";

// s07: one row per agent (text only, no logos) with the very same rule. The
// rule column starts at the same x in every row and all three rule texts
// wipe in on the same frame, so they read as one identical line, three times.

export const AGENT_NAMES = ["Codex", "Claude Code", "Cursor"] as const;

/** The rows fade out while the overview morph pulls the camera back. */
const ROW_FADE_FRAMES = OVERVIEW_MORPH_FRAMES / 2;
/** Portrait: space between the agent name and its rule. */
const STACK_GAP_PX = 10;

type RowsLayout = {
  readonly x: number;
  readonly y: number;
  /** Distance from one row's top to the next. */
  readonly step: number;
  readonly width: number;
  /** Landscape: name and rule share a line; portrait: name above rule. */
  readonly stacked: boolean;
  /** Landscape only: width of the name column. */
  readonly nameColumn: number;
  readonly nameSize: (layout: Layout) => number;
  readonly ruleSize: (layout: Layout) => number;
};

const ROWS_LAYOUTS: Readonly<Record<Orientation, RowsLayout>> = {
  landscape: {
    x: 120,
    y: 356,
    step: 124,
    width: 1440,
    stacked: false,
    nameColumn: 260,
    nameSize: (layout) => layout.type.sub,
    ruleSize: (layout) => layout.type.code,
  },
  portrait: {
    x: 156,
    y: 596,
    step: 216,
    width: 852,
    stacked: true,
    nameColumn: 0,
    nameSize: (layout) => layout.type.sub,
    ruleSize: (layout) => layout.type.heroSmall,
  },
};

function rowHeight(rows: RowsLayout, layout: Layout): number {
  const rule = rows.ruleSize(layout) * LINE_HEIGHT.body;
  if (!rows.stacked) return rule;
  const name = rows.nameSize(layout) * LINE_HEIGHT.code;
  return name + STACK_GAP_PX + rule * ruleLines().length;
}

/** The narration reads the names in c1; fall back to a stagger if not. */
function nameEntrance(time: SceneTime, name: string, index: number): number {
  const earliest = time.arrival + index * STAGGER_FRAMES;
  try {
    return Math.max(time.phrase(name), earliest);
  } catch {
    return earliest;
  }
}

function RuleText({ rows }: { rows: RowsLayout }): ReactNode {
  const layout = useLayout();
  const [first, second] = ruleLines();
  return (
    <BodyText size={rows.ruleSize(layout)} style={{ whiteSpace: "nowrap" }}>
      {rows.stacked ? (
        <>
          <div>{first}</div>
          <div>{second}</div>
        </>
      ) : (
        `${first} ${second}`
      )}
    </BodyText>
  );
}

function AgentRow({
  rows,
  name,
  nameAt,
  ruleAt,
}: {
  rows: RowsLayout;
  name: string;
  nameAt: number;
  ruleAt: number;
}): ReactNode {
  const layout = useLayout();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: rows.stacked ? "column" : "row",
        alignItems: rows.stacked ? "flex-start" : "baseline",
        gap: rows.stacked ? STACK_GAP_PX : 0,
      }}
    >
      <Reveal
        at={nameAt}
        style={{
          ...CODE_STYLE,
          width: rows.stacked ? undefined : rows.nameColumn,
          fontSize: rows.nameSize(layout),
          color: COLORS.accent2,
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </Reveal>
      <Reveal at={ruleAt}>
        <RuleText rows={rows} />
      </Reveal>
    </div>
  );
}

/** The three agent rows (screen space). They fade out from `fadeAt`. */
export function AgentRows({ fadeAt }: { fadeAt: number }): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const rows = ROWS_LAYOUTS[layout.orientation];
  const ruleAt = time.cue("c2");
  const separatorOffset = (rows.step + rowHeight(rows, layout)) / 2;
  const opacity = 1 - progress(time.frame, fadeAt, ROW_FADE_FRAMES, EASE_EXIT);
  if (opacity <= 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      {AGENT_NAMES.map((name, index) => {
        const top = rows.y + index * rows.step;
        const nameAt = nameEntrance(time, name, index);
        return (
          <div key={name}>
            {index > 0 ? (
              <At x={rows.x} y={top - rows.step + separatorOffset}>
                <Reveal at={nameAt}>
                  <Hairline length={rows.width} />
                </Reveal>
              </At>
            ) : null}
            <At x={rows.x} y={top} width={rows.width}>
              <AgentRow
                rows={rows}
                name={name}
                nameAt={nameAt}
                ruleAt={ruleAt}
              />
            </At>
          </div>
        );
      })}
    </div>
  );
}
