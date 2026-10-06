// Room credentials for the e2e server. Test-only values: the webServer in
// playwright.config.ts starts with exactly these, so specs can register the
// browser host page and mint renters' join links.

import { createHash } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { mintRenterSession, mintTicket } from "../../server/src/access";

export const E2E_ROOM = "gaming-pc-1"; // what the /host page registers
export const E2E_MACHINE_KEY = "e2e-machine-key";
/** A crewmate's own gaming PC, which the crew spec brings to a crew; nothing else offers it. */
export const E2E_CREW_PC = "crew-pc-1";
export const E2E_CREW_PC_KEY = "e2e-crew-pc-key";
/** Its owner, the friend the crew spec invites. */
export const E2E_CREW_PC_OWNER = "76561198000000102";
/** A host's gaming PC the seat spec keeps a friend seat at; nothing else offers it. */
export const E2E_SEAT_PC = "seat-pc-1";
export const E2E_SEAT_PC_KEY = "e2e-seat-pc-key";
/** Its owner, the host who saves the seat. */
export const E2E_SEAT_PC_OWNER = "76561198000000201";
/**
 * The PC the watch spec plays on, which its owner brings to the player's crew:
 * watching is for the crew of the PC being played. The /host page registers it.
 */
export const E2E_WATCH_PC = "watch-pc-1";
export const E2E_WATCH_PC_KEY = "e2e-watch-pc-key";
export const E2E_WATCH_PC_OWNER = "76561198000000103";
const E2E_SECRET = "e2e-room-secret-that-is-long-enough-to-pass";
const E2E_SESSION_SECRET = "e2e-session-secret-that-is-long-enough-to-pass";

/**
 * Where a TURN relay listens for watching a crewmate, which is relay-only
 * (server/src/watchIce.ts): e2e/scripts/turn.sh starts one with the test-only
 * credential below, and CI sets this. Unset: no relay, and watching says so.
 */
export const E2E_TURN_URL = process.env.E2E_TURN_URL ?? "";
const E2E_TURN: Record<string, string> = E2E_TURN_URL
  ? { TURN_URLS: E2E_TURN_URL, TURN_USERNAME: "swiff-e2e", TURN_CREDENTIAL: "e2e-only-turn-credential" }
  : {};

export const E2E_ENV = {
  ...E2E_TURN,
  ROOM_SECRET: E2E_SECRET,
  // Steam sign-in refuses to start without its own secret, distinct from ROOM_SECRET.
  SESSION_SECRET: E2E_SESSION_SECRET,
  MACHINE_KEYS: [
    `${E2E_ROOM}:${createHash("sha256").update(E2E_MACHINE_KEY).digest("hex")}`,
    `${E2E_CREW_PC}:${createHash("sha256").update(E2E_CREW_PC_KEY).digest("hex")}:${E2E_CREW_PC_OWNER}`,
    `${E2E_SEAT_PC}:${createHash("sha256").update(E2E_SEAT_PC_KEY).digest("hex")}:${E2E_SEAT_PC_OWNER}`,
    `${E2E_WATCH_PC}:${createHash("sha256").update(E2E_WATCH_PC_KEY).digest("hex")}:${E2E_WATCH_PC_OWNER}`,
  ].join(","),
  // Every game playable, unchecked: the wall's games must not hang on Steam
  // verdicts (server/src/playable.ts, tested on its own with recordings).
  SWIFF_PLAYABILITY: "off",
};

/** The path a renter opens: a fresh ticket for the e2e room. */
export const joinLink = (ttlSeconds = 600) => `/rtc#ticket=${mintTicket(E2E_SECRET, E2E_ROOM, ttlSeconds)}`;

/**
 * Sign the browser in as a renter: the session cookie Steam sign-in would set.
 * The e2e server has no STEAM_API_KEY, so /api/me answers this Steam id with an
 * empty profile, as it does for any deployment without one.
 */
export async function signIn(context: BrowserContext, baseURL: string, steamId = "76561198000000001") {
  const value = mintRenterSession(E2E_SESSION_SECRET, steamId, 600);
  await context.addCookies([{ name: "swiff_session", value, url: baseURL }]);
}
