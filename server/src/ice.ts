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
//   TURN_KEY_ID           A Cloudflare TURN key, as configured before: used for
//   TURN_KEY_API_TOKEN    its generate-ice-servers when nothing else mints.
//
// Neither set: no TURN, and the server behaves exactly as it did before. That
// is the right default — on one LAN a relay is pure cost. A relay that cannot
// mint is never fatal either: that peer is handed none and ICE tries the
// direct paths alone.

import { createHmac } from "node:crypto";
import { sessionSpanMs } from "@swiff/rank";
import { MIN_SECRET_LENGTH } from "./access.js";
import { MAX_MINUTES } from "./platform.js";

/** The most: the longest session's ticket. A ticket minted by hand for longer gets this. */
const MAX_TTL_SECONDS = sessionSpanMs({ rentalMode: true }, MAX_MINUTES) / 1000;

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

/** No relay, and why. */
const off = (warning: string) => ({ relay: NO_RELAY, warnings: [warning] });

/**
 * Seconds from `now` (Unix ms) to the seat's end, at most the longest session.
 * Never rounded up: a credential outliving its seat would relay for nobody's
 * session. Zero or less once the seat has ended, and then nothing is minted.
 */
function ttlFor(seat: RelaySeat, now: number): number {
  return Math.min(MAX_TTL_SECONDS, seat.expiresAt - Math.floor(now / 1000));
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
  let urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const secret = env.TURN_SECRET?.trim() ?? "";
  let endpoint = env.TURN_CREDENTIAL_URL?.trim() ?? "";
  let token = env.TURN_CREDENTIAL_TOKEN?.trim() ?? "";

  // A Cloudflare key from before keeps its relay, when nothing else mints.
  const keyId = env.TURN_KEY_ID?.trim() ?? "";
  const keyToken = env.TURN_KEY_API_TOKEN?.trim() ?? "";
  const legacyKey = Boolean(keyId && keyToken && !endpoint && !token && !secret);
  if (legacyKey) {
    endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    token = keyToken;
    urls = [];
  }

  const gone = ["TURN_USERNAME", "TURN_CREDENTIAL", "TURN_TTL_SECONDS"];
  gone.push(...(legacyKey ? ["TURN_URLS"] : ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"]));
  const stale = gone.filter((name) => env[name]?.trim());
  const ignored = stale.length
    ? [
        `${stale.join(", ")} no longer configure TURN and are ignored — see the TURN variables in docs/phase-1/plan.md`,
      ]
    : [];

  const { relay, warnings } = mintingFrom(urls, secret, endpoint, token, deps);
  return { relay, warnings: [...ignored, ...warnings] };
}

/** The relay minting one way, from a shared secret or an endpoint, and what is wrong with it. */
function mintingFrom(
  urls: string[],
  secret: string,
  endpoint: string,
  token: string,
  deps: Deps,
): { relay: Relay; warnings: string[] } {
  if (secret && endpoint) {
    return off("TURN_SECRET and TURN_CREDENTIAL_URL are both set — no relay runs");
  }

  if (secret) {
    if (urls.length === 0) {
      return off("TURN_SECRET is set without TURN_URLS — no relay runs");
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      return off(`TURN_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — no relay runs`);
    }
    return {
      relay: {
        credentials: async (seat, now = Date.now()) =>
          ttlFor(seat, now) > 0 ? [sharedSecretCredential(secret, urls, seat, now)] : [],
      },
      warnings: [],
    };
  }

  if (endpoint) {
    if (!token) {
      return off("TURN_CREDENTIAL_URL is set without TURN_CREDENTIAL_TOKEN — no relay runs");
    }
    // The token is the long-term secret: it goes to nothing but https.
    if (!endpoint.startsWith("https://")) {
      return off("TURN_CREDENTIAL_URL is not https — no relay runs");
    }
    return { relay: endpointRelay(endpoint, token, urls, deps.fetch ?? globalThis.fetch), warnings: [] };
  }

  if (urls.length) {
    return off("TURN_URLS is set without TURN_SECRET or TURN_CREDENTIAL_URL — no relay runs");
  }
  return { relay: NO_RELAY, warnings: [] };
}

/** Credentials minted per seat by `endpoint`, on `urls` when given, else on the ones it answers. */
function endpointRelay(endpoint: string, token: string, urls: string[], doFetch: typeof fetch): Relay {
  return {
    async credentials(seat, now = Date.now()) {
      const ttl = ttlFor(seat, now);
      if (ttl <= 0) return [];
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
        // A parse error quotes the body, which carries the minted credential.
        const body = (await response.json().catch(() => {
          throw new Error("the answer was not JSON");
        })) as { iceServers?: RTCIceServer | RTCIceServer[] };
        // Only the entries that relay: STUN the peers already have.
        const minted = [body.iceServers ?? []]
          .flat()
          .flatMap(({ urls: answered, username, credential }) =>
            username && credential
              ? [{ urls: urls.length ? urls : dialable(answered), username, credential }]
              : [],
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
