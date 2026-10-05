// One renter's Play, from the PC's side: Steam's sign-in QR code out to the
// renter's page, then straight into the game.
//
//   play(appid) ──► qr ×n ──► signed-in ──► launching ──► game-on-screen
//                   │  (the renter scans it with the Steam app and approves)
//                   └─ again each time Steam shows a new code
//
// Steam sits at its sign-in window from boot, so the first code is out within
// one poll of Play. Once Steam is signed in it is told to launch the game, and
// gamescope puts the game's window on screen: the renter never sees Steam's
// library, its other windows or a desktop. Every event carries the time since
// Play, so each Play measures itself.

import { isSignInUrl, type SteamClient } from "./steam.ts";
import type { Display } from "./x11.ts";

export type PlayEvent =
  /** Steam shows this sign-in code: show it to the renter. Sent again whenever it changes. */
  | { event: "qr"; url: string; atMs: number }
  /** The renter approved the sign-in; Steam is signed in. */
  | { event: "signed-in"; atMs: number }
  /** Steam was told to launch the game. */
  | { event: "launching"; appid: number; atMs: number }
  /** gamescope shows the game: its first frame is on screen. Final. */
  | { event: "game-on-screen"; appid: number; atMs: number }
  /** The play stopped short. Final. */
  | { event: "failed"; reason: "sign-in-timeout" | "launch-timeout" | "stopped"; atMs: number };

export type PlayOptions = {
  steam: SteamClient;
  display: Display;
  emit: (event: PlayEvent) => void;
  /** Stop early, as when whoever asked for the play hangs up. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** How often the screen and Steam are looked at. */
export const POLL_MS = 250;
/** How long the renter has to approve the sign-in on their phone. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long the game has to reach the screen once Steam is told to launch it. */
export const LAUNCH_TIMEOUT_MS = 5 * 60_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sign the renter in to Steam by QR code and launch `appid`; resolves with the final event. */
export async function play(appid: number, opts: PlayOptions): Promise<PlayEvent> {
  const { steam, display, signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? wait;
  const began = now();
  const at = () => now() - began;
  const emit = <E extends PlayEvent>(event: E): E => {
    opts.emit(event);
    return event;
  };

  let shown: string | null = null;
  if (signal?.aborted) return emit({ event: "failed", reason: "stopped", atMs: at() });
  while (!(await steam.signedIn())) {
    if (signal?.aborted) return emit({ event: "failed", reason: "stopped", atMs: at() });
    if (at() >= SIGN_IN_TIMEOUT_MS) return emit({ event: "failed", reason: "sign-in-timeout", atMs: at() });
    const url = (await display.qrCodes()).find(isSignInUrl);
    if (url && url !== shown) {
      shown = url;
      emit({ event: "qr", url, atMs: at() });
    }
    await sleep(POLL_MS);
  }
  emit({ event: "signed-in", atMs: at() });
  // A renter who left while signing in gets no game launched for them.
  if (signal?.aborted) return emit({ event: "failed", reason: "stopped", atMs: at() });
  await steam.launch(appid);
  const launched = at();
  emit({ event: "launching", appid, atMs: launched });
  while ((await display.focusedApp()) !== appid) {
    if (signal?.aborted) return emit({ event: "failed", reason: "stopped", atMs: at() });
    if (at() - launched >= LAUNCH_TIMEOUT_MS)
      return emit({ event: "failed", reason: "launch-timeout", atMs: at() });
    await sleep(POLL_MS);
  }
  return emit({ event: "game-on-screen", appid, atMs: at() });
}
