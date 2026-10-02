import type { Game, HostActions, HostView, Step } from "../model";

export type ScreenProps = {
  view: HostView;
  actions: HostActions;
  go: (step: Step) => void;
};

/** The installed games the owner offers, in the order they are listed. */
export const offeredGames = (view: HostView): Game[] =>
  view.games.installed.filter((g) => view.games.offered.includes(g.appid));

/** "tonight" in the evening and small hours, "today" otherwise. */
export const tonight = (now: number): string => {
  const h = new Date(now).getHours();
  return h >= 17 || h < 5 ? "tonight" : "today";
};
