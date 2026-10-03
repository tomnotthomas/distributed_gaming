// Room credentials for the e2e server. Test-only values: the webServer in
// playwright.config.ts starts with exactly these, so specs can register the
// browser host page and mint renters' join links.

import { createHash } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { mintRenterSession, mintTicket } from "../../server/src/access";

export const E2E_ROOM = "gaming-pc-1"; // what the /host page registers
export const E2E_MACHINE_KEY = "e2e-machine-key";
const E2E_SECRET = "e2e-room-secret-that-is-long-enough-to-pass";
const E2E_SESSION_SECRET = "e2e-session-secret-that-is-long-enough-to-pass";

/** How long a renter who drops has to come back, on the e2e server: short enough to wait out. */
export const E2E_GRACE_MS = 8_000;

export const E2E_ENV = {
  ROOM_SECRET: E2E_SECRET,
  SWIFF_RECONNECT_GRACE_MS: String(E2E_GRACE_MS),
  // Steam sign-in refuses to start without its own secret, distinct from ROOM_SECRET.
  SESSION_SECRET: E2E_SESSION_SECRET,
  MACHINE_KEYS: `${E2E_ROOM}:${createHash("sha256").update(E2E_MACHINE_KEY).digest("hex")}`,
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

/** The cookie header of a signed-in renter, for calling the Booking API straight from a test. */
export const renterCookie = (steamId = "76561198000000002") =>
  `swiff_session=${mintRenterSession(E2E_SESSION_SECRET, steamId, 600)}`;
