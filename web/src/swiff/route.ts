import { crewRouteAt, CREWS_PATH } from "./crews";
import { paidGaming, PLAY_PATH } from "./features";
import { INVITE_PATH, inviteTokenAt } from "./invite";
import { PAIR_PATH, pairKeyAt } from "./pair";
import { SEAT_PATH, seatTokenAt } from "./seat";
import type { Screen } from "./useSwiff";

/** Share your PC has its own address, so an owner can be sent straight to the estimate. */
export const SHARE_PATH = "/share";

/**
 * The screen an address opens: the estimate at /share, the invite a friend was
 * sent at /invite/<token> (and /invite, coming back from sign-in), a friend
 * seat at /seat/<token> (and /seat), pairing a PC at /pair?k=<hash>, the crew pages at /crews and
 * /crews/<id>, the wall everywhere else. With paid gaming off (features.ts)
 * there is no estimate: /share opens the crew pages.
 */
export const screenAt = (pathname: string): Screen =>
  inviteTokenAt(pathname) !== null
    ? "invite"
    : seatTokenAt(pathname) !== null
      ? "seat"
      : pairKeyAt(pathname, "") !== null
        ? "pair"
        : crewRouteAt(pathname) !== null
          ? "crew"
          : pathname.replace(/\/+$/, "") === SHARE_PATH
            ? paidGaming()
              ? "share"
              : "crew"
            : "home";

/**
 * The address a screen keeps: /share for the estimate, /invite for an invite
 * (whose own address, with its token, is kept as it is), /seat for a friend
 * seat (likewise), /pair for pairing a PC (likewise, its key hash in the query), /crews for the crew pages (a crew's own, with its id, is
 * kept as it is), / for everything else: the wall's own address, which is
 * /play while paid gaming is off.
 */
export const pathOf = (screen: Screen): string =>
  screen === "share"
    ? SHARE_PATH
    : screen === "invite"
      ? INVITE_PATH
      : screen === "seat"
        ? SEAT_PATH
        : screen === "pair"
          ? PAIR_PATH
          : screen === "crew"
            ? CREWS_PATH
            : paidGaming()
              ? "/"
              : PLAY_PATH;
