// Bring your own games: a renter plays with their own Steam licence, never the
// host's, so a game can be booked and claimed only when it is in the renter's
// Steam library or free to play. This is the rule the signed-in wall already
// follows (web/src/swiff/steam.ts applySteam), checked again here because a
// request need not come from the wall.
//
// The library is the one the profile read (steam.ts) already holds. A library
// Steam will not show (game details private, no STEAM_API_KEY, or Steam not
// answering) proves nothing is owned, so, as on the wall, only free-to-play
// games can be played until it can be read. Free to play is Steam's store data
// (catalog.ts); when the store cannot be reached, the wall's curated
// free-to-play titles stand in, as they do on the wall.

import { catalogGames } from "./catalog.js";
import { ownsApp, type SteamProfile } from "./steam.js";

/** The curated wall titles marked free to play (web/src/swiff/data.ts). */
const CURATED_FREE = new Set([
  730, // Counter-Strike 2
  2073850, // THE FINALS
]);

/** How long the store may take to say whether a game is free before the curated list answers. */
export const STORE_TIMEOUT_MS = 3_000;

/** Whether anyone can start `appid` without owning it. */
export type FreeToPlay = (appid: number) => Promise<boolean>;

/** Why a game may not be played: not in a library that was read, or no library could be read. */
export type Unlicensed = "not-owned" | "library-unreadable";

/**
 * Steam's store data, waiting at most `timeoutMs`; the curated free-to-play
 * titles when the store does not answer in time.
 */
export const storeFreeToPlay =
  (timeoutMs = STORE_TIMEOUT_MS): FreeToPlay =>
  async (appid) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(resolve, timeoutMs, null)));
    try {
      const games = await Promise.race([catalogGames([appid]), timeout]);
      const game = games?.find((g) => g.appid === appid);
      return game ? game.free : CURATED_FREE.has(appid);
    } finally {
      clearTimeout(timer);
    }
  };

/**
 * Null when the renter may play `appid`: it is in their library, or it is free
 * to play. Otherwise why not, for the refusal to name.
 */
export async function unlicensed(
  profile: SteamProfile,
  appid: number,
  isFree: FreeToPlay,
): Promise<Unlicensed | null> {
  if (ownsApp(profile, appid)) return null;
  if (await isFree(appid).catch(() => CURATED_FREE.has(appid))) return null;
  return profile.lib ? "not-owned" : "library-unreadable";
}
