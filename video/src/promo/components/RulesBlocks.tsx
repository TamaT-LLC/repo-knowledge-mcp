import type { CSSProperties, ReactNode } from "react";

import { useLayout, useSceneTime } from "../context";
import { COLORS } from "../theme";
import { ThreadBranch, ThreadTick } from "./Connector";
import { STATION_NODE_PX } from "./NodeRing";
import {
  CodeLine,
  DataGrid,
  type DataGridSpec,
  REQUEST_ROWS,
  RuleValue,
  responseRows,
} from "./RulesData";
import { Prompt } from "./Text";

// The blocks of s06: the agent's request, the response and the branches that
// join both to the thread. Placement comes from the scene's layout table and
// timing from its beats; everything exits at the camera departure.

const AGENT_LABEL = "coding agent";
const CALL_NAME = "get_rules";

export type RulesBranch = {
  /** Along-axis position on the thread (station space). */
  readonly along: number;
  /** Cross-axis end of the branch (at the block). */
  readonly cross: number;
  /** The ring the branch leaves: the station node or its own tick. */
  readonly ring: "node" | "tick";
};

export type RulesLayout = {
  readonly agent: { readonly x: number; readonly y: number };
  readonly call: { readonly x: number; readonly y: number };
  readonly args: DataGridSpec;
  readonly response: DataGridSpec;
  readonly requestBranch: RulesBranch;
  readonly responseBranch: RulesBranch;
};

export type RulesBeats = {
  readonly agent: number;
  readonly call: number;
  readonly args: number;
  readonly requestBranch: number;
  readonly pulse: number;
  readonly arrive: number;
  readonly response: number;
  readonly slide: number;
  readonly docked: number;
  readonly absorb: number;
};

type BlockProps = { spec: RulesLayout; beats: RulesBeats };

export function RulesRequest({ spec, beats }: BlockProps): ReactNode {
  const layout = useLayout();
  const { exitAt } = useSceneTime();
  return (
    <>
      <CodeLine
        x={spec.agent.x}
        y={spec.agent.y}
        size={layout.type.sub}
        at={beats.agent}
        exitAt={exitAt}
      >
        <Prompt symbol="›_" />
        {AGENT_LABEL}
      </CodeLine>
      <CodeLine
        x={spec.call.x}
        y={spec.call.y}
        size={layout.type.code}
        at={beats.call}
        exitAt={exitAt}
        color={COLORS.accent2}
      >
        {CALL_NAME}
      </CodeLine>
      <DataGrid
        spec={spec.args}
        rows={REQUEST_ROWS}
        at={beats.args}
        exitAt={exitAt}
      />
    </>
  );
}

/** The rule's head waits as an empty slot until the token covers it. */
const SLOT_STYLE: CSSProperties = {
  color: "transparent",
  textDecorationLine: "underline",
  textDecorationStyle: "dashed",
  textDecorationColor: COLORS.hairlineStrong,
};
const DOCKED_STYLE: CSSProperties = { color: COLORS.accent2 };

export function RulesResponse({ spec, beats }: BlockProps): ReactNode {
  const { frame, exitAt } = useSceneTime();
  const headStyle = frame >= beats.docked ? DOCKED_STYLE : SLOT_STYLE;
  return (
    <DataGrid
      spec={spec.response}
      rows={responseRows(<RuleValue headStyle={headStyle} />)}
      at={beats.response}
      exitAt={exitAt}
    />
  );
}

const ringSizeOf = (branch: RulesBranch): number | undefined =>
  branch.ring === "node" ? STATION_NODE_PX : undefined;

export function RulesBranches({ spec, beats }: BlockProps): ReactNode {
  const { exitAt } = useSceneTime();
  const { requestBranch: request, responseBranch: response } = spec;
  return (
    <>
      {request.ring === "tick" ? (
        <ThreadTick
          along={request.along}
          at={beats.requestBranch}
          litAt={beats.pulse}
          exitAt={exitAt}
        />
      ) : null}
      <ThreadBranch
        along={request.along}
        cross={request.cross}
        at={beats.requestBranch}
        ringSize={ringSizeOf(request)}
        exitAt={exitAt}
      />
      <ThreadTick
        along={response.along}
        at={beats.pulse}
        litAt={beats.arrive}
        exitAt={exitAt}
      />
      <ThreadBranch
        along={response.along}
        cross={response.cross}
        at={beats.arrive}
        ringSize={ringSizeOf(response)}
        exitAt={exitAt}
      />
    </>
  );
}
