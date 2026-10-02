// Which size of display the player has, decided in one place. There are two
// big-display tiers; swiff.css keys its big-screen sizes off the
// `data-display` attribute this puts on <html>. Narrow screens are swiff.css's
// own media query.

import { useEffect, useSyncExternalStore } from "react";

export type Display = "normal" | "wide" | "ultra";

/** 2200px and up: the bar and the band grow a step. */
const ULTRA = "(min-width: 2200px)";
/** 1800px and up, or anything wider than 2:1: the game screen grows. */
const WIDE = "(min-width: 1800px), (min-aspect-ratio: 2/1)";

const queries = () => [ULTRA, WIDE].map((q) => window.matchMedia(q));

function current(): Display {
  const [ultra, wide] = queries();
  return ultra!.matches ? "ultra" : wide!.matches ? "wide" : "normal";
}

function subscribe(onChange: () => void) {
  const lists = queries();
  lists.forEach((list) => list.addEventListener("change", onChange));
  return () => lists.forEach((list) => list.removeEventListener("change", onChange));
}

/** The current display tier, kept on <html data-display> for the stylesheet. */
export function useDisplay(): Display {
  const display = useSyncExternalStore(subscribe, current, () => "normal" as Display);
  useEffect(() => {
    document.documentElement.dataset.display = display;
  }, [display]);
  return display;
}
