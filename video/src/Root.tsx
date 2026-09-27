import { Composition } from "remotion";
import editions from "./editions.json";
import { Intro } from "./Intro";
import { LAYOUTS } from "./promo/layout";
import { PromoVideo } from "./promo/PromoVideo";
import { TIMELINE } from "./promo/timeline";

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
    <Composition
      id="RepoKnowledgePromo"
      component={PromoVideo}
      defaultProps={{ orientation: "landscape" as const }}
      durationInFrames={TIMELINE.totalFrames}
      fps={TIMELINE.fps}
      width={LAYOUTS.landscape.width}
      height={LAYOUTS.landscape.height}
    />
    <Composition
      id="RepoKnowledgePromoVertical"
      component={PromoVideo}
      defaultProps={{ orientation: "portrait" as const }}
      durationInFrames={TIMELINE.totalFrames}
      fps={TIMELINE.fps}
      width={LAYOUTS.portrait.width}
      height={LAYOUTS.portrait.height}
    />
  </>
);
