# Swiff host — system design

The gaming PC side of Swiff. An owner installs the host app on their Windows gaming PC;
while a renter plays, the PC runs Steam and the game for them, streams it, and takes their
input. When the session ends, the PC goes back to the owner.

The renter side, and the whole-system architecture: [`renter.md`](renter.md).

![Host isolation](../diagrams/host-isolation.png)

- **STUN** tells each side its own public address, the way the outside world sees it.
  The two sides then swap those addresses through **Connection setup**.
- **TURN** relays the stream when no direct path between the two works.

---

## 1. Functional requirements

1. The owner can install the host app on a Windows gaming PC from a single file.
2. The owner can offer the PC for rent, with a price and how long it is available.
3. The owner can take the PC back at any moment (kill switch).
4. The owner can see whether the PC is idle, available or in a session.
5. The renter can play on the PC without anyone sitting at it: Steam and the game start on
   their own.
6. The renter can control the game with mouse, keyboard and gamepad.
7. The owner gets the PC back, unchanged, when the session ends.
8. The renter keeps their game progress: saves from one session are there in the next,
   on any machine.

---

## 2. Non-functional requirements

| | Requirement | Why |
|---|---|---|
| **Unattended** | The system starts capture, Steam and the game with no one clicking anything on the PC. | A rental machine has nobody sitting at it. |
| **Isolation** | The system runs the session in a separate Windows account and wipes it afterwards. | The renter must never reach the owner's files, passwords or signed-in accounts. |
| **Latency** | The system injects input as OS-level input the moment it arrives. | Input delay is felt far more than video delay. |
| **Correctness of input** | The system never leaves a key held down. | A dropped key-up walks the character into a wall until the session ends. |
| **Liveness** | The system reports the PC's state every few seconds, and stops offering it within seconds of it going offline. | Matching a renter to a dead machine wastes their time. |
| **Durability** | The system uploads the renter's saves before it wipes the session account, and never wipes until the upload succeeds. | The wipe would otherwise delete the renter's progress. |
| **Control** | The system hands the PC back to the owner instantly on the kill switch, and stops input at the same moment. | The owner has to trust they can always take their machine back. |
| **Trust** | The system ships as a signed installer. | Screen capture plus input injection looks like malware to antivirus and SmartScreen. |

---

## 3. Workflow

![Host workflow](../diagrams/host-workflow.png)

1. The owner installs the host app.
2. The owner makes the PC available.
3. The system matches a renter to it.
4. The gaming PC starts Steam and locks the PC.
5. The renter plays.
6. The session ends and the PC goes back to the owner.

Source: [`../diagrams/host-workflow.mmd`](../diagrams/host-workflow.mmd).

---

## 4. Core entities

| Entity | What it is | Key fields |
|---|---|---|
| **Machine** | This PC, as the platform knows it. | `id`, `owner_id`, `gpu`, `cpu`, `price`, `status`, `available_until`, `last_seen_at` |
| **Session** | One renter playing on this PC. | `id`, `booking_id`, `machine_id`, `started_at`, `ended_at`, `price` |
| **Save** | A renter's save data for one game, kept in object storage (S3). | `id`, `renter_id`, `game_id`, `s3_key`, `updated_at` |
| **Session account** | The separate Windows account the session runs in. Created at start, wiped at end. | local only, never leaves the PC |

Machine `status`: `idle` → `available` → `in_session` → `available` (or `idle` when the
owner takes it back).

---

## 5. API

### Host → platform

```
PUT  /machines/:id/availability
  { available: true, until }
  Offer the PC, or take it back (available: false).

POST /machines/:id/heartbeat
  Sent every few seconds. A machine that stops sending is no longer offered.

POST /sessions/:id/start
POST /sessions/:id/end
  { endedAt }
  Mark the session started, and ended (renter left, time ran out, or kill switch).

GET  /sessions/:id/saves
  → 200 { downloadUrl? }
POST /sessions/:id/saves
  → 200 { uploadUrl }
  Short-lived S3 links for this renter's saves for this game. The PC never holds
  storage credentials. Download before the game starts; upload before the wipe.
```

### Connection setup (WebSocket)

| Message | Direction | Meaning |
|---|---|---|
| `register` | PC → server | Open the room and wait for the renter. |
| `join` | server → PC | The renter has arrived; the PC creates the offer. |
| `offer` / `answer` / `ice` | either way | Relayed to the renter untouched. |
| `ping` | every 25 s | Keeps the socket alive. |
