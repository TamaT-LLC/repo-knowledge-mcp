import type { ReactNode } from "react";

import {
  CommandBand,
  type CommandBandSpec,
  commandBandHeight,
} from "../components/CommandBand";
import { Connector } from "../components/Connector";
import { Headline } from "../components/Headline";
import { STATION_NODE_PX } from "../components/NodeRing";
import { Reveal } from "../components/Reveal";
import { At, StationSpace } from "../components/Space";
import { BodyText, CODE_STYLE, Wordmark } from "../components/Text";
import { type SceneTime, useLayout, useSceneTime } from "../context";
import type { Layout, Orientation, Point } from "../layout";
import { headlineOf } from "../story";
import { COLORS, ENTER_FRAMES, LINE_HEIGHT } from "../theme";
import { secondsToFrames } from "../timeline";
import type { SceneProps } from "./types";

// s08-cta (last scene): the camera settles on SETUP. Headline, wordmark,
// command band, URL and requirements enter by 1.1s; after that only the
// caret moves. The thread continues from the SETUP node into the band's left
// edge, so the whole journey ends at the command's "$". At c3 an underline
// runs once under "setup". Nothing exits: every element stays to the end.

const URL = "github.com/TamaT-LLC/repo-knowledge-mcp";
const REQUIREMENTS = [
  "macOS / Linux",
  "Node.js 22.13+（22.x）または 24+",
  "gh CLI",
  "MIT License",
] as const;
const REQUIREMENT_SEPARATOR = " · ";

/** Storyboard entrance times, in seconds from the scene start. */
const ENTRANCE_SECONDS = {
  wordmark: 0.5,
  command: 0.8,
  url: 1.0,
  requirements: 1.1,
} as const;
/** The rail reaches the band exactly when the band starts to wipe in. */
const RAIL_FRAMES = ENTER_FRAMES;

type CtaLayout = {
  readonly wordmark: Point;
  readonly band: CommandBandSpec;
  /** Gap from the band to the URL, and from the URL to the requirements. */
  readonly urlGap: number;
  readonly requirementsGap: number;
  /** Left edge of the URL and the requirements (aligned with the command). */
  readonly textX: number;
  readonly urlSize: (layout: Layout) => number;
  /** Requirement groups per line (portrait wraps after Node.js). */
  readonly requirementLines: readonly (readonly number[])[];
};

const CTA_LAYOUTS: Readonly<Record<Orientation, CtaLayout>> = {
  landscape: {
    wordmark: { x: 117, y: 326 },
    band: {
      x: 120,
      y: 436,
      width: 1440,
      size: 48,
      padLeft: 32,
      padRight: 44,
      padY: 20,
    },
    urlGap: 40,
    requirementsGap: 14,
    textX: 152,
    urlSize: (layout) => layout.type.heroSmall,
    requirementLines: [[0, 1, 2, 3]],
  },
  portrait: {
    wordmark: { x: 152, y: 596 },
    band: {
      x: 96,
      y: 730,
      width: 912,
      size: 36,
      padLeft: 60,
      padRight: 24,
      padY: 22,
    },
    urlGap: 56,
    requirementsGap: 24,
    textX: 156,
    urlSize: (layout) => layout.type.code,
    requirementLines: [
      [0, 1],
      [2, 3],
    ],
  },
};

type CtaBeats = {
  readonly wordmark: number;
  readonly rail: number;
  readonly command: number;
  readonly url: number;
  readonly requirements: number;
  readonly underline: number;
};

function ctaBeats(time: SceneTime): CtaBeats {
  const after = (seconds: number): number =>
    Math.max(time.arrival, secondsToFrames(seconds));
  const command = after(ENTRANCE_SECONDS.command);
  const requirements = after(ENTRANCE_SECONDS.requirements);
  return {
    wordmark: after(ENTRANCE_SECONDS.wordmark),
    rail: Math.max(time.arrival, command - RAIL_FRAMES),
    command,
    url: after(ENTRANCE_SECONDS.url),
    requirements,
    underline: Math.max(time.cue("c3"), requirements + ENTER_FRAMES),
  };
}

/** The thread's continuation from the SETUP node to the band's far edge. */
function Rail({ cta, at }: { cta: CtaLayout; at: number }): ReactNode {
  const layout = useLayout();
  const { band } = cta;
  const isLandscape = layout.orientation === "landscape";
  const node = isLandscape
    ? { x: layout.nodeAnchor, y: layout.threadCross - STATION_NODE_PX / 2 }
    : { x: layout.threadCross, y: layout.nodeAnchor + STATION_NODE_PX / 2 };
  const farEdge = isLandscape
    ? band.y
    : band.y + commandBandHeight(band, layout.orientation);
  return (
    <Connector
      from={node}
      to={{ x: node.x, y: farEdge }}
      at={at}
      duration={RAIL_FRAMES}
    />
  );
}

function Details({
  cta,
  beats,
}: {
  cta: CtaLayout;
  beats: CtaBeats;
}): ReactNode {
  const layout = useLayout();
  const urlSize = cta.urlSize(layout);
  const urlY =
    cta.band.y + commandBandHeight(cta.band, layout.orientation) + cta.urlGap;
  const requirementsY = urlY + urlSize * LINE_HEIGHT.code + cta.requirementsGap;
  return (
    <>
      <At x={cta.textX} y={urlY}>
        <Reveal
          at={beats.url}
          style={{
            ...CODE_STYLE,
            fontSize: urlSize,
            color: COLORS.accent2,
            whiteSpace: "nowrap",
          }}
        >
          {URL}
        </Reveal>
      </At>
      <At x={cta.textX} y={requirementsY}>
        <Reveal at={beats.requirements}>
          <BodyText
            size={layout.type.smallText}
            color={COLORS.muted}
            style={{ whiteSpace: "nowrap" }}
          >
            {cta.requirementLines.map((line) => (
              <div key={line.join("-")}>
                {line
                  .map((index) => REQUIREMENTS[index])
                  .join(REQUIREMENT_SEPARATOR)}
              </div>
            ))}
          </BodyText>
        </Reveal>
      </At>
    </>
  );
}

export function S08Cta({ scene, orientation }: SceneProps): ReactNode {
  const layout = useLayout();
  const time = useSceneTime();
  const cta = CTA_LAYOUTS[orientation];
  const beats = ctaBeats(time);
  return (
    <StationSpace>
      <Headline text={headlineOf(scene.id)} />
      <At x={cta.wordmark.x} y={cta.wordmark.y}>
        <Reveal at={beats.wordmark}>
          <Wordmark size={layout.type.wordmarkCta} />
        </Reveal>
      </At>
      <Rail cta={cta} at={beats.rail} />
      <CommandBand
        spec={cta.band}
        orientation={orientation}
        at={beats.command}
        underlineAt={beats.underline}
      />
      <Details cta={cta} beats={beats} />
    </StationSpace>
  );
}
