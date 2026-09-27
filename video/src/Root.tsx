import { Composition } from "remotion";
import editions from "./editions.json";
import { Intro } from "./Intro";

export const Root = () => (
  <>
    <Composition
      id="RepoKnowledgeIntroQuick"
      component={Intro}
      defaultProps={{ edition: "quick" as const }}
      durationInFrames={editions.quick.frames.reduce((sum, n) => sum + n, 0)}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="RepoKnowledgeIntro"
      component={Intro}
      defaultProps={{ edition: "original" as const }}
      durationInFrames={editions.original.frames.reduce((sum, n) => sum + n, 0)}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
