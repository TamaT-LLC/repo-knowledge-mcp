import type { ReactNode } from "react";

import { useOrientation, useSceneTime } from "../context";
import { exitProgress, wipeMask } from "../motion";
import { ENTER_FRAMES, EXIT_FRAMES, STAGGER_FRAMES } from "../theme";
import { HeroToken, type HeroTokenProps } from "./HeroToken";

export type HeroTokenSwapProps = {
  /** State before the swap: the previous scene's hand-off props. */
  readonly from: HeroTokenProps;
  /** State after the swap: the next scene's hand-off props. */
  readonly to: HeroTokenProps;
  /** Scene-relative frame at which the old tag starts to wipe out. */
  readonly at: number;
};

/** Frame from which the swap has settled into exactly <HeroToken {...to}>. */
export function heroTokenSwapEnd(at: number): number {
  return at + EXIT_FRAMES + ENTER_FRAMES + STAGGER_FRAMES;
}

/**
 * Changes the hero token's state inside a scene without a cut.
 *
 * 1. The old token wipes out (EXIT_FRAMES) on top of a bare copy of its pill,
 *    so only the old tag visibly leaves.
 * 2. The new token enters on top: when the pill variant changes (outline →
 *    active) the new pill wipes over the old one in the thread direction,
 *    then the new tag wipes in.
 *
 * Before `at` this renders exactly <HeroToken {...from} />; from
 * heroTokenSwapEnd(at) on it renders exactly <HeroToken {...to} />, so scene
 * boundaries stay seamless as long as the swap happens away from them.
 */
export function HeroTokenSwap({ from, to, at }: HeroTokenSwapProps): ReactNode {
  const orientation = useOrientation();
  const { frame } = useSceneTime();
  const exit = exitProgress(frame, at);
  if (exit <= 0) return <HeroToken {...from} />;
  const enterAt = at + EXIT_FRAMES;
  const pillChanges = (from.variant ?? "outline") !== (to.variant ?? "outline");
  const bareUntil = pillChanges ? enterAt + ENTER_FRAMES : enterAt;
  const tagAt = enterAt + (pillChanges ? STAGGER_FRAMES : 0);
  return (
    <>
      {frame < bareUntil ? <HeroToken {...from} tag={undefined} /> : null}
      {exit < 1 ? (
        <HeroToken
          {...from}
          style={{ ...from.style, ...wipeMask(orientation, 1, exit) }}
        />
      ) : null}
      {frame >= enterAt ? (
        <HeroToken
          {...to}
          enterAt={pillChanges ? enterAt : to.enterAt}
          tag={to.tag ? { ...to.tag, at: tagAt } : undefined}
        />
      ) : null}
    </>
  );
}
