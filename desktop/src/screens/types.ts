import type { Game, HostActions, HostView, Step } from "../model";

export type ScreenProps = {
  view: HostView;
  actions: HostActions;
  go: (step: Step) => void;
};

/** The games to list: the ones the owner offers where they choose, otherwise every installed game. */
export const listedGames = ({ games }: HostView): Game[] =>
  games.offered === null ? games.installed : games.installed.filter((g) => games.offered!.includes(g.appid));

/** What a zone listing them is called. */
export const gamesTitle = ({ games }: HostView): string =>
  games.offered === null ? "Installed" : "Offering";

/** "tonight" in the evening and small hours, "today" otherwise. */
export const tonight = (now: number): string => {
  const h = new Date(now).getHours();
  return h >= 17 || h < 5 ? "tonight" : "today";
};
