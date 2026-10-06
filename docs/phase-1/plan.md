# Phase 1 — prove the connection

**Goal:** a Windows gaming PC streams its screen to a renter's browser over the public
internet, with the renter able to control it. Nothing else.

Diagrams: `../diagrams/system-architecture.png` (where this sits in the whole system),
`../diagrams/host-isolation.png` (where it goes in phase 2).

Phase 1 builds only the right-hand side of the architecture diagram: **Connection setup**,
**Gaming PC**, **Renter**, **STUN**, **TURN**. No Booking API, no Host API, no Matching,
no Database.

---

## Why this first

Every other box is worthless if the stream does not work. Matchmaking a renter to a machine
they cannot connect to is an expensive way to ship nothing. This is also the only part with
real technical risk — roughly 1 in 5 home connections cannot hold a direct peer connection,
and that is not something you can design around on paper.

---

## What gets built

| Piece            | What it is                                                                    | Where it runs       |
| ---------------- | ----------------------------------------------------------------------------- | ------------------- |
| Signaling server | Node + `ws`. One room. Relays offer/answer/ICE. Reads nothing.                | A cheap VPS, public |
| Host app         | Electron. Captures the screen, creates the offer, injects input.              | Owner's Windows PC  |
| Renter page      | Vite + React. Connects, shows `<video>`, sends input.                         | Any browser         |
| TURN             | Relay for the ~20% that cannot connect directly. Managed for now — see Risks. | Cloudflare          |

One room id, hardcoded. No database. No auth. That is correct for phase 1 and wrong the
moment there is a second machine — see Open questions.

---

## Steps

1. **Signaling server.** Node + `ws`, one in-memory room. Both peers ping every 25s —
   Cloudflare kills idle WebSockets at 100s and the host would drop off silently.
2. **Two tabs, one machine.** Proves offer/answer/ICE exchange. No real media yet.
3. **Across the LAN.** Real `getDisplayMedia` capture. Status line should read `host`.
4. **Host app as Electron.** `setDisplayMediaRequestHandler` answers the screen picker
   programmatically, so no human has to click Share on the gaming PC.
5. **Input over DataChannel.** Mouse and keyboard from the renter, injected on Windows.
   This is the step that makes it a gaming product rather than a screen viewer.
6. **Prove the internet path.** The acceptance criterion, and the step most likely to be
   skipped. See Verification.
7. **Force the relay path** and re-run step 6 with `FORCE_RELAY` on both peers. Managed TURN
   already covers this; self-hosting coturn became a cost decision rather than a blocker —
   see Risks.

Encoder settings that fail silently if omitted:

```ts
await track.applyConstraints({ width: 1920, frameRate: 60 }); // Chrome ignores these in getDisplayMedia
track.contentHint = "motion";
p.degradationPreference = "maintain-resolution"; // else Chrome drops to 320x180 under load
p.encodings[0].maxBitrate = 10_000_000; // else bandwidth estimation saturates the link
receiver.jitterBufferTarget = 0; // largest single latency win
```

---

## Verification

**If both machines share a LAN, ICE picks host candidates and connects locally — it will
work while proving nothing.** That is the trap.

1. Tether the renter to a phone. Carrier CGNAT is symmetric NAT, a genuinely different
   network, five minutes of work. Status line must read `srflx`.
2. `FORCE_RELAY = true` on both peers with a `getStats()` assertion that both selected
   candidates are type `relay`. Needs TURN credentials, which the signaling server now
   mints for itself — `server/src/ice.ts`.
3. Play something for 30 minutes. Watch for the encoder silently degrading.

Status line shows `connectionState` and the selected candidate type throughout — it is the
difference between "it works" and "it works for the reason I think."

---

## Not in scope

- Bookings, queue, matchmaking, Database — nothing to match until one machine streams.
- Payments — no session to charge for yet.
- Host isolation (`host-isolation.png`) — phase 2, but see the risk below.
- Grant tokens, auth, revocation — phase 1 is one hardcoded room on machines you own.
- Web Push, owner onboarding, multiple machines.

---

## Risks

**Capture location is the one thing that is expensive to change later.** Phase 1 captures the
owner's own desktop. Phase 2 moves capture inside a separate Windows account
(`host-isolation.png`). That move touches how the track is acquired and how the app is
launched. Accepted deliberately — proving the media path in the simplest possible setup is
worth the rework — but do it knowingly, and run phase 1 on machines with nothing private
on them.

**TURN cost is decided here, not later.** Self-hosted coturn on a VPS is ~€5/mo with egress
included. This plan originally costed managed TURN at $0.40/GB — ~$1.80 per relayed hour,
which does not survive a gaming workload — and concluded that self-hosting was the only
option. That input price was wrong by 8×.

Cloudflare Realtime TURN is $0.05/GB with the first 1,000 GB each month free. At the current
`maxBitrate` of 10 Mbit/s a relayed hour costs roughly 4.5 GB, so the free tier covers about
220 relayed hours a month and an hour beyond it is ~$0.23. `server/src/ice.ts` mints a
credential per renter's seat, for the renter and for the PC, that expires with the session:
from a self-run coturn's shared secret, or from a provider's credential endpoint such as
Cloudflare's.

**Recommendation: Cloudflare Realtime TURN's free tier for launch, self-run coturn as the
fallback.** Cloudflare's free tier is 1,000 GB a month, shared with its SFU, then about
$0.05/GB of egress: about 220 relayed hours a month free at 10 Mbit/s. The fallback is coturn
on a Hetzner CX23 at about €6/month, IPv4 and 20 TB of traffic included. Nothing has been
bought or signed up for yet, so the configuration stays provider-neutral: `TURN_SECRET` for
coturn, `TURN_CREDENTIAL_URL`/`TURN_CREDENTIAL_TOKEN` for an endpoint such as Cloudflare's.
The relay scenario in `e2e/relay` proves the shared-secret path; the endpoint path is
unit-tested against Cloudflare's documented answer but has not yet run against the real
provider.

The TURN variables (`server/src/ice.ts`). Leave all of them blank on one LAN, and set the
URLs and exactly one way to mint:

| Variable                                               | Meaning                                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURN_URLS`                                            | The relay's URLs, comma-separated, e.g. `turn:relay.example:3478,turns:relay.example:443?transport=tcp`. Optional with an endpoint, whose own URLs are used.                                  |
| `TURN_SECRET`                                          | Self-run coturn: its `static-auth-secret` (`use-auth-secret`), 32 characters or more. The server mints each credential itself.                                                                |
| `TURN_CREDENTIAL_URL` + `TURN_CREDENTIAL_TOKEN`        | A provider endpoint POSTed `{"ttl": <seconds>}` with the token as a bearer header, e.g. `https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers`. https only. |
| `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`                   | An existing Cloudflare setup still works: with none of the above set, the endpoint is derived from the key id and the API token is the bearer token.                                          |
| `TURN_USERNAME`, `TURN_CREDENTIAL`, `TURN_TTL_SECONDS` | No longer used: ignored, with one warning at start.                                                                                                                                           |

The original conclusion still holds at scale — a VPS with included egress wins once relayed
hours are routine — but coturn is now a cost threshold to watch rather than a step to finish
before phase 1 is done. Turn `maxBitrate` down while developing; 2 Mbit/s is watchable for a
connectivity test and makes any tier last five times longer.

**Anti-cheat titles are out of the catalogue.** They detect the virtualization that phase 2
isolation needs — and they are also unplayable at the latency this architecture has. No
loss, but decide it now so the game list is honest.

---

## Open questions

- Room ids are hardcoded in phase 1. Before a second machine exists, decide how a room is
  named and who may join it. Today anyone who knows the id can connect.
- Whose Steam library runs in the session — the renter's own account, or something shipped
  with the machine. This changes what the product is, and phase 2 cannot start without it.
