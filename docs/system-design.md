# Swiff — system design

Rent an idle gaming PC and play it in a browser.

Owners run a small host app on their Windows gaming PC. Renters pick a game on the web,
get matched to a free machine, and play it over a direct WebRTC stream.

![System architecture](diagrams/system-architecture.png)

Source: [`diagrams/system-architecture.mmd`](diagrams/system-architecture.mmd).

---

## 1. Functional requirements

1. The renter can browse the games that can be played.
2. The renter can sign in with Steam. Starting a session requires it; signed-out visitors
   can only browse and never see machine availability.
3. The renter can book a game for a number of minutes.
4. The renter is matched to a free gaming PC that can run the game.
5. The renter can play the game in the browser on the remote gaming PC, with Steam
   already started for them.
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
| **Isolation** | The system keeps the renter away from the owner's files and account. | Owners hand their PC to strangers. See `diagrams/host-isolation.png`. |
| **Cost** | The system relays traffic only for the minority of sessions that need it. | A relayed hour is ~4.5 GB. |

---

## 3. Workflow

![Workflow](diagrams/workflow.png)

Source: [`diagrams/workflow.mmd`](diagrams/workflow.mmd).

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

The wire format lives in `server/src/protocol.ts`.

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
