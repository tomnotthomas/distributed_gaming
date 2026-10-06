// TURN relay for peers that cannot reach each other directly: symmetric NAT,
// carrier CGNAT, firewalls that only let 443 out. Configured here rather than
// in the clients so neither the renter page nor the host .exe has to be
// rebuilt to change it, and so the renter never has to be asked for anything.
//
// Every credential is one seat's in one session: minted when the renter joins,
// one for them (in `joined`) and one for the PC (in `peer-joined`), and good
// only until their ticket, and so the session, ends. Nobody is ever handed the
// relay's own secret or a credential that outlives the session it was given
// for, and a peer that is in no session gets none.
//
//   TURN_URLS             The relay's URLs, comma-separated.
//
// and one way to mint, so the relay can be self-run or bought:
//
//   TURN_SECRET           The relay's shared secret (coturn's static-auth-secret,
//                         the TURN REST API). Minted here: the username is the
//                         expiry and the seat, the credential its HMAC. The
//                         relay itself refuses it once the expiry has passed.
//
//   TURN_CREDENTIAL_URL   An endpoint that mints them, POSTed `{ ttl }` with
//   TURN_CREDENTIAL_TOKEN this bearer token, answering `{ iceServers }`:
//                         Cloudflare Realtime TURN's generate-ice-servers. Its
//                         URLs are used unless TURN_URLS names others.
//
// Neither set: no TURN, and the server behaves exactly as it did before. That
// is the right default — on one LAN a relay is pure cost. A relay that cannot
// mint is never fatal either: that peer is handed none and ICE tries the
// direct paths alone.

import { createHmac } from "node:crypto";
import { MIN_SECRET_LENGTH } from "./access.js";
import { MAX_MINUTES } from "./platform.js";

/** The fewest seconds a credential is minted for, so one minted at a seat's last moment still allocates. */
const MIN_TTL_SECONDS = 60;

/** The most: the longest booking. A ticket minted by hand for longer gets this. */
const MAX_TTL_SECONDS = MAX_MINUTES * 60;

/** How long a join waits for the endpoint before going on without a relay. */
const MINT_TIMEOUT_MS = 5_000;

/** Who a credential is for. */
export type RelaySeat = {
  /** The platform session, or the ticket for one minted by hand, which has none. */
  id: string;
  side: "renter" | "host";
  /** Unix seconds: when the seat's ticket, and so its session, ends. */
  expiresAt: number;
};

export type Relay = {
  /**
   * The relay servers for `seat`, with a credential of its own that expires
   * with it. Empty when no relay is configured or it could not mint; never
   * rejects. `now` is Unix milliseconds.
   */
  credentials: (seat: RelaySeat, now?: number) => Promise<RTCIceServer[]>;
};

type Deps = {
  /** Injected so tests never touch the network. */
  fetch?: typeof globalThis.fetch;
};

const NO_RELAY: Relay = { credentials: async () => [] };

/** Seconds from `now` (Unix ms) to the seat's end, kept within what a relay is minted for. */
function ttlFor(seat: RelaySeat, now: number): number {
  const left = seat.expiresAt - Math.floor(now / 1000);
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, left));
}

/**
 * A TURN REST API credential (draft-uberti-behave-turn-rest, coturn's
 * use-auth-secret): username `<expiry>:<who>`, credential the base64
 * HMAC-SHA1 of the username under the relay's shared secret.
 */
export function sharedSecretCredential(
  secret: string,
  urls: string[],
  seat: RelaySeat,
  now = Date.now(),
): RTCIceServer {
  const expiry = Math.floor(now / 1000) + ttlFor(seat, now);
  const username = `${expiry}:${seat.id}-${seat.side}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { urls, username, credential };
}

/** An entry's URLs without port 53, which browsers refuse to dial and Cloudflare lists anyway. */
function dialable(urls: string | string[]): string[] {
  return [urls].flat().filter((url) => !/:53(\?|$)/.test(url));
}

/** The relay configured in `env`, and what is wrong with the configuration. */
export function relayFromEnv(env: NodeJS.ProcessEnv, deps: Deps = {}): { relay: Relay; warnings: string[] } {
  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const secret = env.TURN_SECRET?.trim() ?? "";
  const endpoint = env.TURN_CREDENTIAL_URL?.trim() ?? "";
  const token = env.TURN_CREDENTIAL_TOKEN?.trim() ?? "";

  const gone = ["TURN_USERNAME", "TURN_CREDENTIAL", "TURN_KEY_ID", "TURN_KEY_API_TOKEN", "TURN_TTL_SECONDS"];
  const stale = gone.filter((name) => env[name]?.trim());
  if (stale.length) {
    return {
      relay: NO_RELAY,
      warnings: [
        `${stale.join(", ")} no longer configure TURN, and no relay runs while they are set — ` +
          "see TURN_SECRET or TURN_CREDENTIAL_URL in .env.example",
      ],
    };
  }

  if (secret && endpoint) {
    return { relay: NO_RELAY, warnings: ["TURN_SECRET and TURN_CREDENTIAL_URL are both set — no relay runs"] };
  }

  if (secret) {
    if (urls.length === 0) {
      return { relay: NO_RELAY, warnings: ["TURN_SECRET is set without TURN_URLS — no relay runs"] };
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      return {
        relay: NO_RELAY,
        warnings: [`TURN_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — no relay runs`],
      };
    }
    return {
      relay: { credentials: async (seat, now) => [sharedSecretCredential(secret, urls, seat, now)] },
      warnings: [],
    };
  }

  if (endpoint) {
    if (!token) {
      return { relay: NO_RELAY, warnings: ["TURN_CREDENTIAL_URL is set without TURN_CREDENTIAL_TOKEN — no relay runs"] };
    }
    // The token is the long-term secret: it goes to nothing but https.
    if (!endpoint.startsWith("https://")) {
      return { relay: NO_RELAY, warnings: ["TURN_CREDENTIAL_URL is not https — no relay runs"] };
    }
    return { relay: endpointRelay(endpoint, token, urls, deps.fetch ?? globalThis.fetch), warnings: [] };
  }

  if (urls.length) {
    return {
      relay: NO_RELAY,
      warnings: ["TURN_URLS is set without TURN_SECRET or TURN_CREDENTIAL_URL — no relay runs"],
    };
  }
  return { relay: NO_RELAY, warnings: [] };
}

/** Credentials minted per seat by `endpoint`, on `urls` when given, else on the ones it answers. */
function endpointRelay(endpoint: string, token: string, urls: string[], doFetch: typeof fetch): Relay {
  return {
    async credentials(seat, now = Date.now()) {
      const ttl = ttlFor(seat, now);
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl }),
          signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        });
        if (!response.ok) {
          // Deliberately not logging the body: on an auth failure it can echo
          // back what was sent, and this is the one secret worth not printing.
          throw new Error(`the request failed with ${response.status}`);
        }
        const body = (await response.json()) as { iceServers?: RTCIceServer | RTCIceServer[] };
        // Only the entries that relay: STUN the peers already have.
        const minted = [body.iceServers ?? []]
          .flat()
          .flatMap(({ urls: answered, username, credential }) =>
            username && credential ? [{ urls: urls.length ? urls : dialable(answered), username, credential }] : [],
          )
          .filter((server) => server.urls.length);
        if (minted.length === 0) throw new Error("the answer carried no TURN server");
        return minted;
      } catch (cause) {
        console.warn(
          `[swiff] could not mint TURN credentials for a ${seat.side}, who goes without a relay:`,
          cause instanceof Error ? cause.message : cause,
        );
        return [];
      }
    },
  };
}
