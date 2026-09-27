import type { ReactNode } from "react";

import { Headline } from "../components/Headline";
import { HeroToken, type HeroTokenProps } from "../components/HeroToken";
import { StationSpace } from "../components/Space";
import { headlineOf } from "../story";
import type { SceneProps } from "./types";

/**
 * Temporary scene body: the script.json headline only (captions come from
 * the global caption track). Pass `token` to keep the hero token riding the
 * focus so the hand-off from the previous scene stays continuous.
 */
export function PlaceholderScene({
  scene,
  token,
  codeTerms,
  headlineExitAt,
}: SceneProps & {
  token?: HeroTokenProps;
  codeTerms?: readonly string[];
  /** Scene-relative exit of the headline (defaults to the departure). */
  headlineExitAt?: number;
}): ReactNode {
  return (
    <>
      <StationSpace>
        <Headline
          text={headlineOf(scene.id)}
          codeTerms={codeTerms}
          exitAt={headlineExitAt}
        />
      </StationSpace>
      {token ? <HeroToken {...token} /> : null}
    </>
  );
}
