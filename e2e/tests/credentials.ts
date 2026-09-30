// Room credentials for the e2e server. Test-only values: the webServer in
// playwright.config.ts starts with exactly these, so specs can register the
// browser host page and mint renters' join links.

import { createHash } from "node:crypto";
import { mintTicket } from "../../server/src/access";

export const E2E_ROOM = "gaming-pc-1"; // what the /host page registers
export const E2E_MACHINE_KEY = "e2e-machine-key";
const E2E_SECRET = "e2e-room-secret-that-is-long-enough-to-pass";

export const E2E_ENV = {
  ROOM_SECRET: E2E_SECRET,
  MACHINE_KEYS: `${E2E_ROOM}:${createHash("sha256").update(E2E_MACHINE_KEY).digest("hex")}`,
};

/** The path a renter opens: a fresh ticket for the e2e room. */
export const joinLink = (ttlSeconds = 600) => `/rtc#ticket=${mintTicket(E2E_SECRET, E2E_ROOM, ttlSeconds)}`;
