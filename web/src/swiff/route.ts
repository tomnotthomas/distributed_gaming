import { INVITE_PATH, inviteTokenAt } from "./invite";
import type { Screen } from "./useSwiff";

/** Share your PC has its own address, so an owner can be sent straight to the estimate. */
export const SHARE_PATH = "/share";

/**
 * The screen an address opens: the estimate at /share, the invite a friend was
 * sent at /invite/<token> (and /invite, coming back from sign-in), the wall
 * everywhere else.
 */
export const screenAt = (pathname: string): Screen =>
  inviteTokenAt(pathname) !== null
    ? "invite"
    : pathname.replace(/\/+$/, "") === SHARE_PATH
      ? "share"
      : "home";

/**
 * The address a screen keeps: /share for the estimate, /invite for an invite
 * (whose own address, with its token, is kept as it is), / for everything else.
 */
export const pathOf = (screen: Screen): string =>
  screen === "share" ? SHARE_PATH : screen === "invite" ? INVITE_PATH : "/";
