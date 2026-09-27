import type { CSSProperties, ReactNode } from "react";
import { interpolateColors } from "remotion";

import { HeroToken } from "../components/HeroToken";
import { NodeRing, TICK_NODE_PX } from "../components/NodeRing";
import { Reveal } from "../components/Reveal";
import { At, StationSpace } from "../components/Space";
import { BodyText, CODE_STYLE } from "../components/Text";
import { WordmarkStrike } from "../components/WordmarkStrike";
import { useLayout, useSceneTime } from "../context";
import { alongCrossToPoint, type Layout, type Orientation } from "../layout";
import { progress } from "../motion";
import {
  COLOR_SHIFT_FRAMES,
  COLORS,
  ENTER_FRAMES,
  STAGGER_FRAMES,
  SURFACE_COLORS,
} from "../theme";
import type { SceneProps } from "./types";

// s02-product: the camera has moved on; the comment stays behind at PR while
// the hero token rides the focus. The wordmark wipes in on arrival, the sub
// line at c2, and at c3 the route ahead lights up as a map on the thread.

const SUB_PRIMARY = "stdio MCP server";
const SUB_SECONDARY = "Codex・Claude Code・Cursor から利用";
const SUB_SEPARATOR = "｜";
const ROUTE = [
  "gh CLI",
  "~/.repo-knowledge/",
  "distill",
  "human review",
  "get_rules",
] as const;
/** A route stop turns from muted to fg this long after it wipes in. */
const ROUTE_LIGHT_DELAY_FRAMES = ENTER_FRAMES / 2;
/** The underline starts just before the wordmark wipe settles. */
const STRIKE_OVERLAP_FRAMES = 4;
const CENTER_PERCENT = -50;

type ProductLayout = {
  readonly wordmark: { readonly x: number; readonly y: number };
  readonly sub: {
    readonly x: number;
    readonly y: number;
    readonly stacked: boolean;
  };
  /** Along-axis position of the first route stop, and the step between. */
  readonly route: { readonly first: number; readonly step: number };
};

const PRODUCT_LAYOUTS: Readonly<Record<Orientation, ProductLayout>> = {
  landscape: {
    wordmark: { x: 112, y: 292 },
    sub: { x: 120, y: 478, stacked: false },
    route: { first: 640, step: 240 },
  },
  portrait: {
    wordmark: { x: 150, y: 342 },
    sub: { x: 156, y: 472, stacked: true },
    route: { first: 664, step: 128 },
  },
};

function SubLine({ product }: { product: ProductLayout }): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const { sub } = product;
  return (
    <At x={sub.x} y={sub.y}>
      <Reveal at={time.cue("c2")}>
        {/* What it is reads first (fg); where it runs follows (fg 70%). */}
        <BodyText size={layout.type.sub} color={SURFACE_COLORS.textSecondary}>
          {sub.stacked ? (
            <>
              <div style={{ color: COLORS.fg }}>{SUB_PRIMARY}</div>
              <div>{SUB_SECONDARY}</div>
            </>
          ) : (
            <span style={{ whiteSpace: "nowrap" }}>
              <span style={{ color: COLORS.fg }}>{SUB_PRIMARY}</span>
              <span style={{ color: COLORS.hairlineStrong, margin: "0 0.4em" }}>
                {SUB_SEPARATOR}
              </span>
              {SUB_SECONDARY}
            </span>
          )}
        </BodyText>
      </Reveal>
    </At>
  );
}

function routeLabelBox(layout: Layout, along: number): CSSProperties {
  const tick = alongCrossToPoint(layout, along, layout.threadCross);
  if (layout.axis === "x") {
    return {
      left: tick.x,
      top: tick.y + layout.stationLabelOffset.y,
      transform: `translateX(${CENTER_PERCENT}%)`,
    };
  }
  return {
    left: tick.x + layout.stationLabelOffset.x,
    top: tick.y + layout.stationLabelOffset.y,
    transform: "none",
  };
}

function RouteStop({
  text,
  along,
  at,
}: {
  text: string;
  along: number;
  at: number;
}): ReactNode {
  const layout = useLayout();
  const { frame } = useSceneTime();
  const lit = progress(
    frame,
    at + ROUTE_LIGHT_DELAY_FRAMES,
    COLOR_SHIFT_FRAMES,
  );
  const tick = alongCrossToPoint(layout, along, layout.threadCross);
  const half = TICK_NODE_PX / 2;
  return (
    <>
      <At x={tick.x - half} y={tick.y - half}>
        <Reveal at={at} style={{ width: TICK_NODE_PX, height: TICK_NODE_PX }}>
          <NodeRing
            center={{ x: half, y: half }}
            size={TICK_NODE_PX}
            lit={lit}
            unlitColor={COLORS.muted}
          />
        </Reveal>
      </At>
      <div style={{ position: "absolute", ...routeLabelBox(layout, along) }}>
        <Reveal at={at}>
          <span
            style={{
              ...CODE_STYLE,
              fontSize: layout.type.tag,
              whiteSpace: "nowrap",
              color: interpolateColors(lit, [0, 1], [COLORS.muted, COLORS.fg]),
            }}
          >
            {text}
          </span>
        </Reveal>
      </div>
    </>
  );
}

function RouteMap({ product }: { product: ProductLayout }): ReactNode {
  const time = useSceneTime();
  const start = time.cue("c3");
  return ROUTE.map((text, i) => (
    <RouteStop
      key={text}
      text={text}
      along={product.route.first + i * product.route.step}
      at={start + i * STAGGER_FRAMES}
    />
  ));
}

export function S02Product({ orientation }: SceneProps): ReactNode {
  const time = useSceneTime();
  const product = PRODUCT_LAYOUTS[orientation];
  return (
    <>
      <StationSpace>
        <At x={product.wordmark.x} y={product.wordmark.y}>
          <Reveal at={time.arrival} exitAt={time.exitAt}>
            <WordmarkStrike
              at={time.arrival + ENTER_FRAMES - STRIKE_OVERLAP_FRAMES}
            />
          </Reveal>
        </At>
        <SubLine product={product} />
        <RouteMap product={product} />
      </StationSpace>
      <HeroToken />
    </>
  );
}
