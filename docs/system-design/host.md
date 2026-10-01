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

|                          | Requirement                                                                                                           | Why                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Unattended**           | The system starts capture, Steam and the game with no one clicking anything on the PC.                                | A rental machine has nobody sitting at it.                                           |
| **Isolation**            | The system runs the session in a separate Windows account and wipes it afterwards.                                    | The renter must never reach the owner's files, passwords or signed-in accounts.      |
| **Latency**              | The system injects input as OS-level input the moment it arrives.                                                     | Input delay is felt far more than video delay.                                       |
| **Correctness of input** | The system never leaves a key held down.                                                                              | A dropped key-up walks the character into a wall until the session ends.             |
| **Liveness**             | The system reports the PC's state every few seconds, and stops offering it within seconds of it going offline.        | Matching a renter to a dead machine wastes their time.                               |
| **Durability**           | The system uploads the renter's saves before it wipes the session account, and never wipes until the upload succeeds. | The wipe would otherwise delete the renter's progress.                               |
| **Control**              | The system hands the PC back to the owner instantly on the kill switch, and stops input at the same moment.           | The owner has to trust they can always take their machine back.                      |
| **Trust**                | The system ships as a signed installer.                                                                               | Screen capture plus input injection looks like malware to antivirus and SmartScreen. |

---

## 3. Workflow

![Host workflow](../diagrams/host-workflow.png)

1. The owner installs the host app.
2. The owner makes the PC available.
3. A renter picks it, or the queue matches a renter to it.
4. The background service gets a session key and starts the streamer and Steam in the
   separate Windows account.
5. The renter plays.
6. The session ends and the PC goes back to the owner.

Source: [`../diagrams/host-workflow.mmd`](../diagrams/host-workflow.mmd).

---

## 4. Core entities

| Entity              | What it is                                                                        | Key fields                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Machine**         | This PC, as the platform knows it.                                                | `id`, `owner_id`, `name`, hardware, installed games, `controls`, `price`, `status`, `available_until`, `last_seen_at` |
| **Session**         | One renter playing on this PC.                                                    | `id`, `booking_id`, `machine_id`, `started_at`, `ended_at`, `price`                                                   |
| **Save**            | A renter's save data for one game, kept in object storage (S3).                   | `id`, `renter_id`, `game_id`, `s3_key`, `updated_at`                                                                  |
| **Session account** | The separate Windows account the session runs in. Created at start, wiped at end. | local only, never leaves the PC                                                                                       |

Machine `status`: `idle` → `available` → `reserved` → `in_session` → `available` (or
`idle` when the owner takes it back, `offline` when it stops sending heartbeats).

---

## 5. API

### Host → platform

Served under `/api` (`server/src/api.ts`). Every call carries the machine key as
`Authorization: Bearer <machine key>`; a session call needs the key of the machine the
session runs on.

```
PUT  /machines/:id/availability
  { available: true, until?, price?, ...report }
  → 200 { id, status, gpu, cpu, price, session? }
  Offer the PC, or take it back (available: false), which ends whatever it was doing.
  `until` is an ISO date; `price` is cents per hour. `report` is below.

POST /machines/:id/heartbeat
  { ...report }
  → 200 { id, status, gpu, cpu, price, session? }
  Sent every 5 s. A machine silent for 15 s is `offline` and no longer offered: its
  reserved booking goes to another machine, its running session ends. Its next
  heartbeat offers it again. `session.id` names the session a renter has claimed; the
  PC normally hears of it sooner, pushed as `session-claimed` (below).

POST /machines/:id/session
  { sessionId }
  → 201 { sessionId, sessionKey, expiresAt }
  Start the host session for the claimed session `sessionId`: its short-lived key is
  what the streamer in the renter's account registers with. → 409 not-claimed when
  `sessionId` is not the session running on this machine. Contract:
  [`session-keys.md`](session-keys.md).

POST /sessions/:id/start
POST /sessions/:id/end
  { endedAt? }
  Mark the session started (the renter arrived), and ended. → 409 once the session is
  over; → 400 if the body carries a `reason`. The server alone decides why a session
  ended, so a host can never claim credit for one: `time_up` once the server sees the
  session past its expiry, `owner_kill` for any earlier end the host or owner triggers,
  `renter` only when the renter leaves with their own ticket (renter.md), and from its
  own sweeps `time_up` or `grace_expired` (the renter never arrived) when the join ticket
  runs out and `host_offline` when the machine goes silent. The reason feeds the
  machine's stability (below).

GET  /sessions/:id/saves
  → 200 { downloadUrl? }
POST /sessions/:id/saves
  → 200 { uploadUrl }
  Short-lived S3 links for this renter's saves for this game. The PC never holds
  storage credentials. Download before the game starts; upload before the wipe.
```

Whenever the platform session ends — the host ends it, the booked time runs out, the
machine goes silent or the owner takes it back — the server also ends the PC's host
session ([`session-keys.md`](session-keys.md)): its session keys die and the streamer is
put out with `session-ended`. The Windows service must treat that denial, or a heartbeat
whose `session.id` has changed or is missing, as the signal to tear down the renter
account session.

### Stability

The server keeps seven days of each machine's history (`server/src/stability.ts`):
how long it was offered and how much of that its heartbeats covered, how often it
dropped offline, how its sessions ended, and the renter's stream quality
(`POST /api/sessions/:id/qos`, authenticated with the session's join ticket:
`{ fps, bitrate, rttMs, packetLoss }`). `@swiff/rank` buckets that into Steady, OK,
Shaky or New.

### Host report

The PC describes itself in the body of its availability and heartbeat calls. Every
section is optional: one that is sent replaces what the platform stored for it, one that
is left out keeps it. Send every section with the first availability call, `games` again
whenever the installed games change, `net` after each upload test, and nothing more on a
plain heartbeat. A body is at most 32 KB.

```json
{
  "name": "Nova-01",
  "hardware": {
    "gpu": "NVIDIA GeForce RTX 4070",
    "vramMb": 12288,
    "ramMb": 32768,
    "cpu": "AMD Ryzen 7 7800X3D",
    "cores": 8,
    "encoders": ["h264", "hevc", "av1"],
    "display": { "width": 2560, "height": 1440, "refreshHz": 144 }
  },
  "games": [730, 570],
  "controls": ["kb", "mouse", "pad"],
  "net": { "rttMs": 12, "jitterMs": 2.5, "upMbps": 48 }
}
```

| Field               | Rule                                                                                                                                           | Where the PC gets it                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `name`              | 1–64 characters, shown to renters                                                                                                              | The owner, in the host app                                             |
| `hardware`          | All seven fields required                                                                                                                      |                                                                        |
| `hardware.gpu`      | 1–200 characters, the adapter's name as Windows reports it; scored against the GPU score table (`packages/rank`), and an unknown card scores 0 | DXGI adapter description                                               |
| `hardware.vramMb`   | Whole MB, 0–262144; stored as the whole GB when within 3% of it (8028 → 8192): drivers report under the marketed size; else kept as sent       | DXGI `DedicatedVideoMemory`                                            |
| `hardware.ramMb`    | Whole MB, 0–4194304; snapped to a whole GB in the same way (16311 → 16384), other values kept                                                  | WMI `Win32_PhysicalMemory` capacities, summed                          |
| `hardware.cpu`      | 1–200 characters                                                                                                                               | WMI `Win32_Processor.Name`                                             |
| `hardware.cores`    | Whole number, 1–1024: physical cores                                                                                                           | WMI `Win32_Processor.NumberOfCores`, summed                            |
| `hardware.encoders` | Any of `h264`, `hevc`, `av1`: what the GPU can encode the stream with                                                                          | NVENC, AMF or QSV probe                                                |
| `hardware.display`  | `width`, `height` (1–16384) and `refreshHz` (1–1000), whole numbers: the display the stream captures                                           | The primary display's mode                                             |
| `games`             | Up to 2000 Steam appids, whole numbers from 1: installed and ready to launch. `[]` means none                                                  | `libraryfolders.vdf` → `appmanifest_<appid>.acf` with `StateFlags` = 4 |
| `controls`          | Any of `kb`, `mouse`, `pad`; `pad` only when the ViGEmBus driver is installed                                                                  | Driver check                                                           |
| `net`               | All three fields required, numbers from 0: `rttMs` and `jitterMs` up to 60000, `upMbps` up to 100000                                           | Round trip to the server, and an upload test                           |

A bad field is a `400` naming it; nothing in that body is stored. The matcher gives a
booking only to a machine that lists the game in `games` and meets the game's minimum
GPU score, RAM and VRAM, so a PC that has not sent `hardware` and `games` is never
matched.

### Connection setup (WebSocket)

| Message                    | Direction   | Meaning                                                                                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `register`                 | PC → server | Open the room and wait for the renter. Carries the machine key.                                                                           |
| `session-claimed`          | server → PC | A renter claimed this PC: `{ sessionId, appid, minutes }`. The service starts the host session for that `sessionId` at once.              |
| `denied`                   | server → PC | The machine key was refused. The app stops sharing and does not retry, except on `session-active` ([`session-keys.md`](session-keys.md)). |
| `join`                     | server → PC | The renter has arrived; the PC creates the offer.                                                                                         |
| `offer` / `answer` / `ice` | either way  | Relayed to the renter untouched.                                                                                                          |
| `ping`                     | every 25 s  | Keeps the socket alive.                                                                                                                   |

The machine key comes from `npm run machine-key -- <machine-id>`. The host app keeps it
encrypted with Electron `safeStorage` (Windows DPAPI), and the renderer can only reach it
through two calls in `desktop/preload.cjs`. The server stores only its hash. See "Room
access" in [`renter.md`](renter.md).

During a renter's session the machine key stays with a background service outside the
renter's Windows account; the streamer registers with a short-lived session key instead.
The contract for the Windows side is in [`session-keys.md`](session-keys.md).
