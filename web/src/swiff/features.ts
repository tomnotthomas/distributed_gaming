// The server's product switches (server/src/features.ts), from the meta tag it
// puts in every page. A page without one (vite on its own, a test) has them off.

/**
 * Whether the paid marketplace is on: the game wall as the start page, PCs of
 * people you don't know, and earning with your PC. Off, the app is crews
 * only: "/" is the server's start page and a signed-in player's home is their crew.
 */
export const paidGaming = (): boolean =>
  document.querySelector('meta[name="paid-gaming"]')?.getAttribute("content") === "on";

/** Where the game wall lives while paid gaming is off: "/" is the server's start page then. */
export const PLAY_PATH = "/play";
