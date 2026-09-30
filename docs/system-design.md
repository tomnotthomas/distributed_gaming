# Swiff — system design

Rent an idle gaming PC and play it in a browser.

Owners run a small host app on their Windows gaming PC. Renters pick a game on the web,
get matched to a free machine, and play it over a direct WebRTC stream.

Status: the **connection** (Renter, Gaming PC, Connection setup, STUN, TURN) is built —
see [`phase-1/plan.md`](phase-1/plan.md). Everything on the booking side (Booking API,
Queue, Matchmaker, Database) is **design only**.

![System architecture](diagrams/system-architecture.png)

Source: [`diagrams/system-architecture.mmd`](diagrams/system-architecture.mmd).

---

## 1. Functional requirements

1. The renter can browse the games that can be played.
2. The renter can sign in with Steam. Starting a session requires it; signed-out visitors
   can only browse and never see machine availability.
3. The renter can book a game for a number of minutes.
4. The renter is matched to a free gaming PC that can run the game.
5. The renter can see and hear the machine in the browser, and control it with mouse,
   keyboard and gamepad.
6. The renter can end the session and is charged for the time played.
7. The owner can offer a PC for rent, with its hardware, price and how long it is available.
8. The owner can take the machine back at any moment (kill switch).

**Out of scope for now:** payments, owner onboarding, anti-cheat titles, running more than
one session per machine.

---

## 2. Non-functional requirements

| | Requirement | Why |
|---|---|---|
| **Latency** | The system keeps input-to-picture as low as the network allows, and keeps video off Swiff servers unless it has to relay it. | It is a game, not a video. Every hop is felt. |
| **Quality** | The system streams 1080p at 60 fps, ~10 Mbit/s, and holds resolution under load. | What a gaming PC is being rented for. |
| **Connectivity** | The system connects from any home or mobile network. | ~1 in 5 connections cannot hold a direct path (symmetric NAT, carrier CGNAT); TURN covers them. |
| **Consistency** | The system gives a machine to **at most one** booking at a time. | Two renters on one PC is the worst failure the product can have. |
| **Availability** | The system stops offering a PC that goes offline within seconds. | Matching a renter to a dead machine wastes their time. |
| **Isolation** | The system keeps the renter away from the owner's files and account. | Owners hand their PC to strangers. Phase 2 (`diagrams/host-isolation.png`). |
| **Cost** | The system relays traffic only for the minority of sessions that need it. | A relayed hour is ~4.5 GB. |

---

## 3. Workflow

### 3.1 A PC becomes available

1. The owner starts the host app and marks the machine *available now*, until a given time.
2. The host app writes that to the database and keeps sending a **heartbeat**
   (`last_seen_at`). A machine whose heartbeat stops is no longer considered free.

### 3.2 A renter books a game

1. The renter, signed in with Steam, sends `POST /bookings` to the **Booking API**.
2. The API stores the booking as `queued` and puts it on the **Queue**. The request returns
   straight away; matching happens in the background.
3. The **Matchmaker worker** pulls the next booking off the queue.
4. Every 5 s it looks for free machines in the database: available, heartbeat recent, and
   not already held by someone.
5. It picks one and writes a **reservation** with an `expires_at`. The reservation *holds*
   that machine for this booking only. If the renter does not claim it in time, the
   reservation lapses and the machine is free for the next booking.
6. It sends a **session grant** to Connection setup: the room id and who may join it.

### 3.3 The renter connects

1. The renter polls `GET /bookings/:id` until it reads `matched`, then calls
   `POST /bookings/:id/claim`. That turns the reservation into a **session** and returns
   the room to join.
2. Both the renter's browser and the gaming PC open a WebSocket to **Connection setup**
   and join that room. Connection setup only lets in the two parties named in the grant.
3. They exchange an offer, an answer and ICE candidates through it (SDP + ICE relay).
4. Each side asks **STUN** what its public address is, and ICE tries the paths cheapest
   first: same network → direct across the internet → **TURN** relay.
5. One **WebRTC peer connection** opens directly between the two. Video and audio go
   PC → renter; input goes renter → PC over data channels. Connection setup is no longer
   on the path.

### 3.4 The session ends

1. The renter leaves, the booked time runs out, or the owner hits the kill switch.
2. The host app writes *session ended* with `ended_at`; the price is worked out from the
   time played. The machine goes back to available.

---

## 4. Core entities

| Entity | What it is | Key fields |
|---|---|---|
| **Machine** | A gaming PC offered for rent. | `id`, `owner_id`, `gpu`, `cpu`, `price`, `status`, `available_until`, `last_seen_at` |
| **Booking** | A renter's request to play a game for N minutes. | `id`, `renter_id`, `game_id`, `minutes`, `status` |
| **Reservation** | A machine held for one booking, for a limited time. | `id`, `booking_id`, `machine_id`, `expires_at` |
| **Session** | Time actually played on a machine. What gets charged. | `id`, `booking_id`, `machine_id`, `started_at`, `ended_at`, `price` |
| **User** | A renter or owner, identified by their Steam account. | `id`, `steam_id` |
| **Game** | Something in the catalogue. Comes from Steam. | `id` (Steam app id), `name` |

Booking `status`: `queued` → `matched` → `playing` → `ended` (or `expired` if the
reservation lapses unclaimed).

---

## 5. API

All requests are HTTPS and carry the Steam sign-in session. Only `GET /games` works signed
out.

### Booking API

```
GET  /games
  → 200 [{ id, name, image }]
  List the games that can be booked.

POST /bookings
  { gameId, minutes }
  → 202 { bookingId, status: "queued" }
  Request a game for N minutes. Matching happens in the background.

GET  /bookings/:id
  → 200 { bookingId, status, machine? }
  Check whether a machine has been found yet.

POST /bookings/:id/claim
  → 200 { sessionId, roomId, signalingUrl }
  Take the matched machine before the reservation expires. Returns the room to join.
  → 409 if the reservation has already expired.
```

### Connection setup (WebSocket)

Built today — the wire format lives in `server/src/protocol.ts`.

| Message | Direction | Meaning |
|---|---|---|
| `register` | PC → server | The machine opens its room. |
| `join` | renter → server | The renter joins the room; the PC is told. |
| `offer` / `answer` / `ice` | either way | Relayed to the other side untouched. |
| `ping` | both, every 25 s | Keeps the socket alive (Cloudflare closes idle ones at 100 s). |

The server hands both peers the STUN/TURN settings when they join, with short-lived TURN
credentials it mints itself (`server/src/ice.ts`).

### Peer connection (WebRTC)

| Channel | Direction | Carries |
|---|---|---|
| Video track | PC → renter | The screen, 1080p60 |
| Audio track | PC → renter | The machine's sound, Opus stereo |
| Data channels | renter → PC | Mouse, keyboard and gamepad input |
