# Swiff renter — system design

Rent an idle gaming PC and play it in a browser.

Owners run a small host app on their Windows gaming PC. Renters pick a game on the web,
get matched to a free machine, and play it over a direct WebRTC stream.

The gaming PC side: [`host.md`](host.md).

![System architecture](../diagrams/system-architecture.png)

Source: [`../diagrams/system-architecture.mmd`](../diagrams/system-architecture.mmd).

---

## 1. Functional requirements

1. The renter can browse the games that can be played.
2. The renter can sign in with Steam. Starting a session requires it; signed-out visitors
   can only browse and never see machine availability.
3. The renter can book a game for a number of minutes.
4. The renter is matched to a free gaming PC that can run the game. The renter's own PC is
   never listed, recommended or matched (gate E5 in `packages/rank`).
5. The renter can play the game in the browser on the remote gaming PC, with Steam
   already started for them.
6. The renter can end the session and is charged for the time played.
7. The renter keeps their game progress between sessions, on any machine.
8. The owner can offer a PC for rent, with its hardware, price and how long it is available.
9. The owner can take the machine back at any moment (kill switch).

**Out of scope for now:** payments, owner onboarding, anti-cheat titles, running more than
one session per machine.

---

## 2. Non-functional requirements

|                  | Requirement                                                                                                                  | Why                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Latency**      | The system keeps input-to-picture as low as the network allows, and keeps video off Swiff servers unless it has to relay it. | It is a game, not a video. Every hop is felt.                                                   |
| **Quality**      | The system streams 1080p at 60 fps, ~10 Mbit/s, and holds resolution under load.                                             | What a gaming PC is being rented for.                                                           |
| **Connectivity** | The system connects from any home or mobile network.                                                                         | ~1 in 5 connections cannot hold a direct path (symmetric NAT, carrier CGNAT); TURN covers them. |
| **Consistency**  | The system gives a machine to **at most one** booking at a time.                                                             | Two renters on one PC is the worst failure the product can have.                                |
| **Availability** | The system stops offering a PC that goes offline within seconds.                                                             | Matching a renter to a dead machine wastes their time.                                          |
| **Isolation**    | The system keeps the renter away from the owner's files and account.                                                         | Owners hand their PC to strangers. See `../diagrams/host-isolation.png`.                        |
| **Cost**         | The system relays traffic only for the minority of sessions that need it.                                                    | A relayed hour is ~4.5 GB.                                                                      |

---

## 3. Workflow

![Workflow](../diagrams/workflow.png)

1. The renter signs in with Steam.
2. The renter chooses a game.
3. The renter picks one of the ranked available PCs, or joins the queue when none fits;
   matching only serves the queue.
4. The page claims the reserved PC (booking `claimed`).
5. The gaming PC starts the streamer and Steam in the separate Windows account and locks
   the PC.
6. The renter plays.

Steps 1 and 3 are the design; today sign-in hands the profile to the page but the server
keeps no session, and the Booking API matches every booking through the queue.

Source: [`../diagrams/workflow.mmd`](../diagrams/workflow.mmd).

---

## 4. Core entities

| Entity          | What it is                                                      | Key fields                                                                                                            |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Machine**     | A gaming PC offered for rent.                                   | `id`, `owner_id`, `name`, hardware, installed games, `controls`, `price`, `status`, `available_until`, `last_seen_at` |
| **Booking**     | A renter's request to play a game for N minutes.                | `id`, `renter_id`, `game_id`, `minutes`, `status`, `last_seen_at`                                                     |
| **Reservation** | A machine held for one booking, for a limited time.             | `id`, `booking_id`, `machine_id`, `expires_at`                                                                        |
| **Session**     | Time actually played on a machine. What gets charged.           | `id`, `booking_id`, `machine_id`, `started_at`, `ended_at`, `end_reason`, `price`, `ticket_id`, `qos`                 |
| **Save**        | A renter's save data for one game, kept in object storage (S3). | `id`, `renter_id`, `game_id`, `s3_key`, `updated_at`                                                                  |
| **User**        | A renter or owner, identified by their Steam account.           | `id`, `steam_id`                                                                                                      |
| **Game**        | Something in the catalogue. Comes from Steam.                   | `id` (Steam app id), `name`                                                                                           |

Booking `status`: `queued` → `matched` → `claimed` → `playing` → `ended`. A booking
becomes `expired` when its reservation lapses unclaimed after the renter has checked on
it since the match, or when it is queued and the renter has not checked on it for 2
minutes. A reservation that lapses while the renter has not been heard from since the
match puts the booking back in the queue in its old place.

Machines, bookings, reservations and sessions are one SQLite table each
(`server/src/platform.ts`, through Node's built-in `node:sqlite`, so dev, tests and CI
need no database server). The file is `DATABASE_PATH`; unset, the data lives in memory
and resets with the server. Users, games and saves have no table yet: a user is their
Steam id (a booking's `renter_id`, a machine's `owner_id`), games come from Steam, and
saves are not built.

---

## 5. API

All requests are HTTPS, served under `/api` (`server/src/api.ts`). They carry the
renter's sign-in session, and only `GET /games` and `POST /signout` work signed out;
everything else answers `401` without one.

### Sign-in session

Sign-in is Steam OpenID (`server/src/steam.ts`): `/auth/steam/login` sends the browser to
Steam, and `/auth/steam/return` checks Steam's answer with Steam itself. When Steam vouches
for the player, the server signs them in with a cookie (`server/src/signin.ts`) and sends
them back to the page they came from, flagged `#steam=ok` (or `#steam=denied`). Nothing
about the player rides in the URL.

| Cookie          | Holds                                                                                     | Attributes                                                                    |
| --------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `swiff_session` | The renter's Steam id and an expiry (7 days), signed with `SESSION_SECRET` (HMAC-SHA256). | `HttpOnly`, `SameSite=Lax`, `Path=/`; `Secure` whenever the site is on https. |

- **`SESSION_SECRET` is its own secret,** at least 32 characters and never `ROOM_SECRET`,
  so a leak of one forges neither the other's tickets nor sessions. Without it nobody can
  sign in, and so nobody can book.
- **The server keeps no session state.** Signing out clears the browser's cookie; a copy
  of the cookie taken before then stays valid until it expires. `HttpOnly` keeps it out of
  reach of scripts on the page, and `SameSite=Lax` keeps it off another site's POSTs, so
  another site cannot book or claim as the renter.
- **The page asks the server who is signed in** (`GET /me`), on every load, so a signed-in
  renter stays signed in across reloads until the cookie expires or they sign out.

### Booking API

```
GET  /games
  → 200 [{ id, name, image }]
  List the games that can be booked. Works signed out.

GET  /me
  → 200 { steamId, profile }
  Who is signed in, and their Steam profile (persona, avatar, library), read from Steam.
  → 401 when nobody is.

POST /signout
  → 204
  Clear the sign-in cookie. Works signed out.

POST /bookings
  { gameId, minutes }
  → 202 { bookingId, status }
  Request a game for N minutes (at most 720), as the signed-in renter. Matching happens
  in the background; `status` is "matched" already when a machine was free.

GET  /bookings/:id
  → 200 { bookingId, status, machine?, claimBy?, price? }
  Check whether a machine has been found yet. `claimBy` is when the reservation
  lapses; `price` (cents) is set once the session has ended. Checking also keeps a
  queued booking in the queue: one nobody has checked on for 2 minutes expires.
  → 404 for an unknown booking, and for one another renter made: a renter only ever
  sees their own.

POST /bookings/:id/claim
  → 200 { sessionId, roomId, signalingUrl, ticket }
  Take the matched machine before the reservation expires (60 s). Returns the room to
  join and the join ticket that opens it (see "Room access" below), valid for the
  booked minutes or until the session ends, whichever comes first.
  → 409 if the booking is not matched (its reservation lapsed, or it has expired).
  → 404 for a booking another renter made.

POST /sessions/:id/qos
  { fps, bitrate, rttMs, packetLoss }
  Report stream quality during the session, with the join ticket as bearer, and once
  more up to 60 s after it ends while the ticket is still valid. Feeds the machine's
  stability; see host.md, "Stability". Later concern: each report counts equally in the
  session's running mean, so a policy for duplicate or uneven sampling (bounded report
  intervals, report ids, and telling sparse from absent telemetry) is still to come.

POST /sessions/:id/leave
  The renter is leaving: ends the session as `renter`, with the join ticket as bearer.
  → 403 for another session's ticket, → 409 once the session is over. The only way a
  session is recorded as the renter's own choice to end it. A renter who just closes the
  page leaves the host to end the session, which is recorded as `host_end` (or `time_up`
  within 10 s of its expiry) and counts neither for nor against the machine's completion.
```

Matching runs in the server process, every second and on every change: the oldest
queued booking gets the cheapest live machine that is free for all of its minutes, has
the game installed and meets the game's minimum hardware (ranking gates E2 and E3), and
is not the renter's own (E5); the machine is reserved for it. A machine's owner is the
Steam id on its `MACHINE_KEYS` entry, recorded on the machine each time it checks in; a
machine whose entry names no owner can be matched to anyone, and the server warns about
it at startup. A reservation lasts 60 s. When it lapses unclaimed, a renter who checked
on the booking since the match saw it and let it go, so the booking expires and the
machine goes to the next in line; a renter who has not been heard from since the match
was away, so the booking goes back to the queue in its old place. A machine that goes
silent also hands its reserved booking back to the queue.

A queued booking expires 2 minutes after the renter last checked on it, so a renter who
closed the tab does not hold a machine when one frees up. Until then the server keeps it
resumable: a renter who comes back within those 2 minutes (browser reopened, laptop woke
up) and checks on the same booking id keeps their place, even if a machine was reserved
for them and lapsed while they were away. The web helper
`web/src/swiff/booking.ts` stores the booking id in `localStorage` when it books and, on
page load, resumes polling the stored booking, forgetting it once the booking is claimed,
ended or expired. **Not wired in yet:** no booking page calls the helper; the booking UI
will.

**Known gap:** keeping their place does not give a returning renter a fresh claim window.
If a machine is reserved for them when they come back, their first check counts as having
seen the match, so they get only what is left of that 60 s reservation, which may be a few
seconds. Without a page that claims the machine automatically they can lose the booking
this way. The renter page will claim automatically (Swiff v7); tracked in
[#35](https://github.com/tomnotthomas/distributed_gaming/issues/35).

### Connection setup (WebSocket)

The wire format lives in `server/src/protocol.ts`.

| Message                    | Direction        | Meaning                                                                                                  |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `register`                 | PC → server      | The machine opens its room, with its machine key.                                                        |
| `join`                     | renter → server  | The renter joins the room its ticket names; the PC is told.                                              |
| `denied`                   | server → either  | The key or ticket was refused, or the room is taken. The socket is closed and the client does not retry. |
| `offer` / `answer` / `ice` | either way       | Relayed to the other side untouched.                                                                     |
| `ping`                     | both, every 25 s | Keeps the socket alive (Cloudflare closes idle ones at 100 s).                                           |

### Room access

A room is one gaming PC. Nobody gets into it without a credential, and with none
configured the server lets nobody in (`server/src/access.ts`).

| Side      | Credential                                                                                                                   | Checked how                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Gaming PC | **Machine key**: a random secret per machine, pasted into the host app once and stored there encrypted by Windows.           | The server keeps only its SHA-256 (`MACHINE_KEYS`) and compares hashes. A wrong key cannot register or take over the room. |
| Renter    | **Join ticket**: names one room and an expiry, signed by the platform with `ROOM_SECRET` (HMAC-SHA256). Returned by `claim`. | The server checks the signature and expiry, and refuses a ticket whose session has ended.                                  |

- **One renter at a time.** While a renter is in the room, a join with a different
  ticket is refused (`room-taken`). The same ticket again is the same renter
  reloading the page and takes the seat back.
- **The ticket travels in the URL fragment** (`/rtc#ticket=…`), which browsers never
  send to a server, proxy or `Referer` header.
- **Sockets outside a room relay nothing**, and frames over 64 KB close the socket.
- **A ticket dies with its session.** `claim` records the ticket on the session. Once the
  session ends (the host ends it, the owner takes the machine back, the machine goes
  silent or the booked time runs out), a join with that ticket is refused (`bad-ticket`)
  and a renter still in the room with it is put out within a second.
- **Tickets come from `claim`,** which only the signed-in renter who made the booking
  can call. `npm run ticket -- <machine-id>` still mints one by hand for testing. Machine keys are made by hand:
  `npm run machine-key -- <machine-id> <owner-steam-id>`.

The server hands both peers the STUN/TURN settings when they join, with short-lived TURN
credentials it mints itself (`server/src/ice.ts`).

### Peer connection (WebRTC)

| Channel       | Direction   | Carries                           |
| ------------- | ----------- | --------------------------------- |
| Video track   | PC → renter | The screen, 1080p60               |
| Audio track   | PC → renter | The machine's sound, Opus stereo  |
| Data channels | renter → PC | Mouse, keyboard and gamepad input |
