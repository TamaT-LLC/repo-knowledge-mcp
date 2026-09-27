import type { ReactNode } from "react";
import { interpolateColors } from "remotion";

import { useSceneTime } from "../context";
import type { Point } from "../layout";
import { progress } from "../motion";
import { COLOR_SHIFT_FRAMES, COLORS, STAGGER_FRAMES } from "../theme";
import { type PulseShape, pulseOnce } from "./pulseOnce";
import { Reveal } from "./Reveal";
import { At } from "./Space";
import { BodyText, Code, Hairline, Label } from "./Text";
import { Toggle, TRACK_WIDTH_PX } from "./Toggle";

// s04: the "外部送信" list. No cards: three rows separated by hairlines.
// Every row ends with a toggle (OFF = muted outline) and "既定：無効". One row
// is switched ON by the pointer (vermilion, the human's decision); later the
// rows that stayed OFF brighten their "既定：無効" once.

export const OPTIN_SECTION_LABEL = "外部送信";
const DEFAULT_OFF = "既定：無効";
const ROW_GAP_PX = 24;
const STACK_GAP_PX = 4;
const VALUE_PULSE: PulseShape = { rise: 8, hold: 22, fall: 16 };

export type OptinListLayout = {
  readonly x: number;
  readonly width: number;
  /** Top of the section label, and of the first hairline. */
  readonly labelY: number;
  readonly top: number;
  readonly rowHeight: number;
  /** 9:16: the default value sits under the name instead of beside it. */
  readonly stacked: boolean;
  readonly nameSize: number;
  readonly valueSize: number;
};

export type OptinListCues = {
  /** First row wipes in (the label a few frames earlier). */
  readonly at: number;
  /** The chosen row's toggle turns ON. */
  readonly onAt: number;
  /** The OFF rows brighten "既定：無効" once. */
  readonly pulseAt: number;
};

/** Centre of a row's toggle (station space), for the pointer. */
export function optinToggleCenter(list: OptinListLayout, index: number): Point {
  return {
    x: list.x + list.width - TRACK_WIDTH_PX / 2,
    y: list.top + index * list.rowHeight + list.rowHeight / 2,
  };
}

function RowValue({ size, color }: { size: number; color: string }): ReactNode {
  return (
    <BodyText size={size} color={color} style={{ whiteSpace: "nowrap" }}>
      {DEFAULT_OFF}
    </BodyText>
  );
}

function MethodRow({
  list,
  index,
  name,
  on,
  valueColor,
  at,
}: {
  list: OptinListLayout;
  index: number;
  name: string;
  on: number;
  valueColor: string;
  at: number;
}): ReactNode {
  const value = <RowValue size={list.valueSize} color={valueColor} />;
  return (
    <At x={list.x} y={list.top + index * list.rowHeight} width={list.width}>
      <Reveal at={at}>
        <Hairline length="100%" />
        <div
          style={{
            height: list.rowHeight - 1,
            display: "flex",
            alignItems: "center",
            gap: ROW_GAP_PX,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Code size={list.nameSize} style={{ whiteSpace: "nowrap" }}>
              {name}
            </Code>
            {list.stacked ? (
              <div style={{ marginTop: STACK_GAP_PX }}>{value}</div>
            ) : null}
          </div>
          {list.stacked ? null : value}
          <Toggle on={on} />
        </div>
      </Reveal>
    </At>
  );
}

/** Label + rows + closing hairline. Place inside <StationSpace>. */
export function OptinList({
  list,
  methods,
  onIndex,
  cues,
}: {
  list: OptinListLayout;
  methods: readonly string[];
  onIndex: number;
  cues: OptinListCues;
}): ReactNode {
  const { frame } = useSceneTime();
  const on = progress(frame, cues.onAt, COLOR_SHIFT_FRAMES);
  const offValue = interpolateColors(
    pulseOnce(frame, cues.pulseAt, VALUE_PULSE),
    [0, 1],
    [COLORS.muted, COLORS.fg],
  );
  const lastAt = cues.at + methods.length * STAGGER_FRAMES;
  return (
    <>
      <At x={list.x} y={list.labelY}>
        <Reveal at={cues.at - STAGGER_FRAMES}>
          <Label>{OPTIN_SECTION_LABEL}</Label>
        </Reveal>
      </At>
      {methods.map((name, index) => (
        <MethodRow
          key={name}
          list={list}
          index={index}
          name={name}
          on={index === onIndex ? on : 0}
          valueColor={index === onIndex ? COLORS.muted : offValue}
          at={cues.at + index * STAGGER_FRAMES}
        />
      ))}
      <At
        x={list.x}
        y={list.top + methods.length * list.rowHeight}
        width={list.width}
      >
        <Reveal at={lastAt}>
          <Hairline length="100%" />
        </Reveal>
      </At>
    </>
  );
}
