# Session keys — contract for the Windows side

How the gaming PC opens its room for a renter without the machine key ever entering the
renter's Windows account. The server side is built (`server/src/sessions.ts`,
`server/src/access.ts`, `server/src/protocol.ts`); this is what the **PC service** and the
**streamer** have to do against it.

## Why

The renter plays in `swiff-renter`, a separate Windows account they control (see
[`prototypes/credential-provider/README.md`](../../prototypes/credential-provider/README.md)).
Anything stored in that account, the renter can read. The machine key is long-lived and
opens the machine's room for good, so it must stay outside that account.

| Process              | Runs as                                 | Holds                                                                  |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| **PC service**       | a Windows service (SYSTEM)              | the machine key, DPAPI machine scope                                   |
| **Streamer**         | `swiff-renter`, in the renter's session | one session key, for this room and session only, expiring in minutes   |
| **Signaling server** | the platform                            | the machine key's SHA-256, `ROOM_SECRET`, and which room is in session |

## Sequence

```
PC service                          server                          streamer (swiff-renter)
----------                          ------                          -----------------------
POST /api/machines/:id/session ───► 201 { sessionId, sessionKey, expiresAt }
   (Bearer machine key)             any machine-key host in the room is put out
launch streamer, sessionKey on
its command line or stdin ─────────────────────────────────────────► register { hostId, sessionKey }
                                                                   ◄ registered
                                    renter joins with their ticket  ◄► offer / answer / ice
            ... session runs; the key expires, the socket stays ...
DELETE /api/machines/:id/session ─► 204; every key of the session is dead
                                    ─────────────────────────────► denied session-ended, socket closed
                                    renter gets peer-left
```

## Endpoints

Both are called by the **PC service only**, over HTTPS to the signaling server, with
`Authorization: Bearer <machine key>`. `:id` is the machine id (the room). Requests have no
body; responses are JSON with `cache-control: no-store`.

| Call                               | Success                                    | Refusals                                                          |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `POST /api/machines/:id/session`   | `201 { sessionId, sessionKey, expiresAt }` | `401 bad-machine-key`, `409 session-active`, `503 not-configured` |
| `DELETE /api/machines/:id/session` | `204`, whether or not a session was live   | `401 bad-machine-key`, `503 not-configured`                       |

- A refusal body is `{ "error": "<code>" }` (`SessionError` in `protocol.ts`). A wrong
  method answers `405`.
- `expiresAt` is Unix seconds. The key registers nothing after it.
- There is one live session per room. A second start while one is live is `409`; end it
  first. There is no way to get another key for a live session: a streamer whose key has
  expired gets a new session (end, then start).

## WebSocket: the streamer's `register`

The same socket, heartbeat and relay as the phase-1 host (see `protocol.ts` and
[`host.md`](host.md) §5); only the credential changes:

```json
{ "type": "register", "hostId": "<machine id>", "sessionKey": "<from the service>" }
```

Exactly one of `key` (machine key) or `sessionKey`. The server answers `registered`, or
`denied` and closes with code `4003`:

| `denied.reason`   | When                                                            | Streamer should           |
| ----------------- | --------------------------------------------------------------- | ------------------------- |
| `bad-session-key` | forged, expired, for another room, or its session has ended     | exit; the service decides |
| `session-ended`   | sent to a registered streamer when the service ends the session | exit                      |

A second `register` with a valid key for the same session replaces the older socket — that
is the streamer reconnecting, exactly as a phase-1 host does.

## The machine key during a session

While a room has a live session — from start until end, whether or not the streamer is
connected — a `register` with the machine key is refused with `session-active`. The machine
key therefore cannot displace the streamer serving a renter, nor slip into the room while
the streamer is still starting. When no session is live, the machine-key `register` works
exactly as before, so the phase-1 host app keeps working.

The machine key can still **end** a session (that is the owner's kill switch), which hangs
up on the streamer and tells the renter `peer-left`. It cannot take a live room over
silently.

## Lifetimes

| Thing       | Lifetime                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session key | 5 minutes from issue (`SESSION_KEY_TTL_SECONDS`). Checked only when registering: a streamer already registered keeps its socket after the key expires. |
| Session     | From start until end. The server does not end a session on its own; a new key means a new session.                                                     |
| Everything  | Held in the server's memory. A server restart forgets every session.                                                                                   |

## Failure behaviour

| What happens                             | Result                                             | PC service does                                                    |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Streamer's socket drops, key still fresh | it reconnects and re-registers with the same key   | nothing                                                            |
| Streamer's socket drops, key expired     | `denied bad-session-key`                           | `DELETE`, start, relaunch the streamer with the new key            |
| Streamer crashes                         | renter gets `peer-left`; room stays in the session | relaunch it; if the key has expired, `DELETE` and start first      |
| Service restarts and lost the session    | the old session is still live; start answers `409` | on startup, always `DELETE` first, then start when a renter is due |
| Signaling server restarts                | every session forgotten; keys refused              | start a new session, relaunch the streamer                         |
| Server cannot be reached for `DELETE`    | the room stays in the session; the streamer stays  | retry until `204`; stop the streamer locally meanwhile             |
| `ROOM_SECRET` not set on the server      | every call `503 not-configured`                    | report the machine unavailable                                     |

Never pass the machine key to the streamer, write it into the renter's profile, or log it,
the session key or the ticket. The session key is harmless outside its room and after its
session ends, but within them it opens the room.

## Out of scope here

The Windows service and the streamer themselves, input, the database, booking.
