import type { Screen } from "./useSwiff";

/** Share your PC has its own address, so an owner can be sent straight to the estimate. */
export const SHARE_PATH = "/share";

/** The screen an address opens: the estimate at /share, the wall everywhere else. */
export const screenAt = (pathname: string): Screen =>
  pathname.replace(/\/+$/, "") === SHARE_PATH ? "share" : "home";

/** The address a screen keeps: /share for the estimate, / for everything else. */
export const pathOf = (screen: Screen): string => (screen === "share" ? SHARE_PATH : "/");
