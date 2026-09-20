# Phase 1 — prove the connection

**Goal:** a Windows gaming PC streams its screen to a renter's browser over the public
internet, with the renter able to control it. Nothing else.

Diagrams: `../diagrams/system-architecture.png` (where this sits in the whole system),
`../diagrams/host-isolation.png` (where it goes in phase 2).

Phase 1 builds only the right-hand side of the architecture diagram: **Connection setup**,
**Gaming PC**, **Renter**, **STUN**, **TURN**. No Booking API, no Queue, no Matchmaker
worker, no Database.

---

## Why this first

Every other box is worthless if the stream does not work. Matchmaking a renter to a machine
they cannot connect to is an expensive way to ship nothing. This is also the only part with
real technical risk — roughly 1 in 5 home connections cannot hold a direct peer connection,
and that is not something you can design around on paper.

---

## What gets built

| Piece | What it is | Where it runs |
|---|---|---|
| Signaling server | Node + `ws`. One room. Relays offer/answer/ICE. Reads nothing. | A cheap VPS, public |
| Host app | Electron. Captures the screen, creates the offer, injects input. | Owner's Windows PC |
| Renter page | Vite + React. Connects, shows `<video>`, sends input. | Any browser |
| coturn | TURN relay for the ~20% that cannot connect directly. | Same VPS |

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
7. **Stand up coturn** and re-run step 6 with relay forced.

Encoder settings that fail silently if omitted:

```ts
await track.applyConstraints({ width: 1920, frameRate: 60 }); // Chrome ignores these in getDisplayMedia
track.contentHint = "motion";
p.degradationPreference = "maintain-resolution";             // else Chrome drops to 320x180 under load
p.encodings[0].maxBitrate = 10_000_000;                      // else bandwidth estimation saturates the link
receiver.jitterBufferTarget = 0;                             // largest single latency win
```

---

## Verification

**If both machines share a LAN, ICE picks host candidates and connects locally — it will
work while proving nothing.** That is the trap.

1. Tether the renter to a phone. Carrier CGNAT is symmetric NAT, a genuinely different
   network, five minutes of work. Status line must read `srflx`.
2. `FORCE_RELAY = true` on both peers with a `getStats()` assertion that both selected
   candidates are type `relay`. Needs coturn from step 7.
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
included. Managed TURN at $0.40/GB is ~$1.80 per relayed hour, which does not survive a
gaming workload. Stand up coturn in step 7 rather than reaching for a managed provider.

**Anti-cheat titles are out of the catalogue.** They detect the virtualization that phase 2
isolation needs — and they are also unplayable at the latency this architecture has. No
loss, but decide it now so the game list is honest.

---

## Open questions

- Room ids are hardcoded in phase 1. Before a second machine exists, decide how a room is
  named and who may join it. Today anyone who knows the id can connect.
- Whose Steam library runs in the session — the renter's own account, or something shipped
  with the machine. This changes what the product is, and phase 2 cannot start without it.
