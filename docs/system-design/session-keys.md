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

## One session, one id

A host session is the PC's side of the platform session a renter claimed
([`host.md`](host.md) §5), not a session of its own: it has the platform session's id, it
can only be started for the session claimed on this machine, and it ends whenever that
platform session ends. The service never invents a session; it starts the one it was told
about.

## Sequence

```
PC service                          server                          streamer (swiff-renter)
----------                          ------                          -----------------------
register { hostId, key } ─────────► registered
   (its own machine-key socket)
                                    a renter claims this machine
                                  ◄ session-claimed { sessionId, appid, minutes }
POST /api/machines/:id/session ───► 201 { sessionId, sessionKey, expiresAt }
   { sessionId } (Bearer machine key)  the machine-key socket is put out (session-active)
launch streamer, sessionKey on
its command line or stdin ─────────────────────────────────────────► register { hostId, sessionKey }
                                                                   ◄ registered
                                    renter joins with their ticket  ◄► offer / answer / ice
            ... session runs; the key expires, the socket stays ...
DELETE /api/machines/:id/session ─► 204; every key of the session is dead
                                    ─────────────────────────────► denied session-ended, socket closed
                                    renter gets peer-left
```

## Learning of a claim: `session-claimed`

The service keeps its own WebSocket registered with the **machine key** (in Swiff OS, a
host certificate: see Control and hosting credentials) while the PC is offered (the
phase-1 `register`, see `protocol.ts`). The moment a renter claims the
machine, the server pushes to that socket, and to no other machine's:

```json
{ "type": "session-claimed", "sessionId": "<platform session id>", "appid": 730, "minutes": 60 }
```

`appid` is the Steam game booked and `minutes` the time booked. The service answers by
starting the host session for exactly that `sessionId`. A streamer registered with a
session key never receives it.

If the service was not connected when the claim happened, it hears `session-claimed` as
soon as it registers with the machine key while that session runs with no host session
live; the heartbeat (`POST /api/machines/:id/heartbeat`) also carries the same id as
`session.id`. Start with that.

Until the Windows service exists, the host app (the desktop app and the web host page)
stands in for it: `startHostSession` with `serveClaims` answers `session-claimed` by
starting that session, registers again with the session key, and goes back to the machine
key once the session is over. Given `hostCert`, a getter for host certificates from
attestation, it registers and starts each session with a fresh certificate instead of the
machine key, and still ends sessions with the machine key; it never attests itself. A
session key refused with `bad-session-key` is replaced as the table under Failure behaviour
says: `DELETE`, then start the same `sessionId` again. A start or end that fails on the
network or with a `5xx` is tried up to three times; a `4xx` refusal goes back to waiting
for the next claim at once. A machine key refused with
`session-active` (the app reloaded mid-session) ends that session with `DELETE` and
registers again, and the claim is pushed to it again; a `DELETE` that still fails on the
network or with a `5xx` registers again and retries, and only a `4xx` refusal of that
`DELETE` stops the app as a denial.

Starting the host session puts the machine-key socket out with `denied session-active`,
and the machine key cannot register again while the session is live. Once the session has
ended (`session.id` gone from the heartbeat), the service registers its machine-key socket
again to hear the next claim.

## Endpoints

Both are called by the **PC service only**, over HTTPS to the signaling server, with
`Authorization: Bearer <machine key or host certificate>`. `:id` is the machine id (the room). Start has a JSON
body (`SessionStart` in `protocol.ts`); end has none. Responses are JSON with
`cache-control: no-store`.

| Call                                             | Success                                    | Refusals                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/machines/:id/session` `{ sessionId }` | `201 { sessionId, sessionKey, expiresAt }` | `401 bad-machine-key`, `401 bad-host-cert`, `403 attestation-required`, `400 bad-request`, `409 not-claimed`, `409 session-active`, `503 not-configured`, `500 internal-error` |
| `DELETE /api/machines/:id/session`               | `204`, whether or not a session was live   | `401 bad-machine-key`, `401 bad-host-cert`, `503 not-configured`, `500 internal-error`                                                                                         |

The bearer is the machine key or a host certificate (see Control and hosting credentials
below). Starting is hosting: `403 attestation-required` answers the machine key when hosting
requires attestation. Ending is control too, so the machine key always may.

- A refusal body is `{ "error": "<code>" }` (`SessionError` in `protocol.ts`). A wrong
  method answers `405`.
- `400 bad-request`: the body is not JSON or has no `sessionId` string.
- Both answer CORS (`access-control-allow-origin: *`, and an `OPTIONS` preflight), so the
  desktop app can call them from its own origin. The machine key in the header is the only
  credential; nothing ambient rides along.
- `409 not-claimed`: `sessionId` is not the session running on this machine: unknown,
  another machine's, or already ended.
- `expiresAt` is Unix seconds. The key registers nothing after it.
- There is one live session per room. A second start while one is live is `409
session-active`; end it first. There is no way to get another key for a live session: a
  streamer whose key has expired needs the host session ended and started again for the
  same `sessionId`. That start issues a new key, and every key from before the end stays
  dead.

## WebSocket: the streamer's `register`

The same socket, heartbeat and relay as the phase-1 host (see `protocol.ts` and
[`host.md`](host.md) §5); only the credential changes:

```json
{ "type": "register", "hostId": "<machine id>", "sessionKey": "<from the service>" }
```

Exactly one of `key` (machine key), `hostCert` (host certificate, the PC service in Swiff OS)
or `sessionKey`. The server answers `registered`, or `denied` and closes with code `4003`:

| `denied.reason`   | When                                                        | Streamer should           |
| ----------------- | ----------------------------------------------------------- | ------------------------- |
| `bad-session-key` | forged, expired, for another room, or its session has ended | exit; the service decides |
| `session-ended`   | sent to a registered streamer when its session ends         | exit                      |

A second `register` with a valid key for the same session replaces the older socket — that
is the streamer reconnecting, exactly as a phase-1 host does.

The server also ends the host session whenever the renter's platform session ends
([`host.md`](host.md): the host ends it, the renter leaves, the booked time runs out, the
machine goes silent or the owner takes it back), exactly as `DELETE .../session` does. The service must treat
a `session-ended` denial, or a heartbeat whose `session.id` has changed or is missing, as
the signal to tear down the renter account session. Its later `DELETE` still answers `204`.

## The machine key during a session

While a room has a live session — from start until end, whether or not the streamer is
connected — a `register` with the machine key is refused with `session-active`. The machine
key therefore cannot displace the streamer serving a renter, nor slip into the room while
the streamer is still starting. When no session is live, the machine-key `register` works
exactly as before, so the phase-1 host app keeps working.

The machine key can still **end** a session (the owner's confirmed end-early action, see
[`host.md`](host.md) requirement 3), which hangs up on the streamer and tells the renter
`peer-left`. It cannot take a live room over silently.

Whenever the server puts a host out — a machine-key host when a session starts, the
streamer when it ends — the host leaves the room at once and the renter gets `peer-left`
before any new host can register. A socket that has been put out or replaced relays nothing
more while it closes.

## Control and hosting credentials

The machine key opens the room for good, and in Swiff OS rental mode it stays in the owner's
Windows, which does not run during a rental. So the server splits a machine's rights between
two credentials (`server/src/attestation.ts`):

| Credential                     | Held by                                      | Rights                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Machine key** (control)      | the owner's host app                         | set availability, price and share-until; heartbeat; end a session (`DELETE .../session`, `POST /api/sessions/:id/end`), the owner's confirmed end-early                                                                                          |
| **Host certificate** (hosting) | `swiff-hostd` in Swiff OS, after attestation | `register` the PC service's socket, which hears `session-claimed` and gets TURN credentials in `registered`; start a host session, which mints the session keys; report the renter in (`POST /api/sessions/:id/start`); heartbeat; end a session |

`HOSTING_ATTESTATION` picks the policy per environment:

- `optional` (the default, for development): the machine key also has the hosting rights, at
  an explicit `unattested` tier, so the desktop host app works exactly as described above.
- `required`: only a host certificate hosts. A machine-key `register` is refused with
  `denied attestation-required`, and a hosting call made with it answers
  `403 attestation-required`. Its control rights are unchanged. A free machine is offered
  and matched only while a socket that may host it is open: the machine key's availability
  and heartbeats keep its terms and its liveness, but never put it on the market alone. An
  unrecognised value counts as `required`.

A host certificate is a token the server signs with `ROOM_SECRET` under its own domain,
naming one room, its tier, an id of its own and an expiry ten minutes away. It is the PC
service's credential, exactly where the machine key was: refused with `session-active` while
a session is live, and never handed to the streamer. A certificate for a machine no longer
in `MACHINE_KEYS` hosts nothing. Two rules make `swiff-hostd` attest again:

- **One session start per certificate.** Starting a host session spends it. A spent
  certificate is refused for another start (`401 bad-host-cert`) and for `register`
  (`denied bad-host-cert`); it may still report that session's renter in, heartbeat and end
  it. So the machine attests again after every session, before it can be offered again.
- **Expiry puts the socket out.** A socket registered with a certificate is put out with
  `denied bad-host-cert` when the certificate expires, so it never hears a claim on an
  expired one; `swiff-hostd` attests again and registers anew, at least every ten minutes
  while it waits for a renter.

Spent certificates are kept in memory until they expire. A server restart forgets them, so a
certificate spent just before a restart could start one more session within what is left of
its ten minutes.

### Attestation

```
swiff-hostd                                      server
POST /api/machines/:id/attest-challenge  ──────► 200 { nonce, expiresAt }       60 s, one certificate
TPM quote with qualifying data SHA-256(nonce),
event log, EK certificate, AK proof
POST /api/machines/:id/attest            ──────► verifier judges the evidence, the hardware
  { nonce, evidence }                            floor picks the tier
                                         ◄────── 200 { hostCert, tier, expiresAt }
```

Refusals: `400 bad-request` (`413` with the same body when it is too large); `401 bad-nonce`
(forged, expired, another machine's, already used up by the attempt that earned a
certificate, or being judged in another attempt right now); `403 attestation-refused` with
`reason` `evidence-rejected` or `below-hardware-floor`; `404 not-found` for a machine with no
key; `503 verifier-unavailable` when the verifier itself fails; `503 not-configured` with no
`ROOM_SECRET` or no verifier. Bodies are JSON with `cache-control: no-store`; the types are in
`protocol.ts`.

The verifier sits behind the `AttestationVerifier` interface (`verify({ room, nonce, evidence })`
returning the platform facts it verified). It is picked with `ATTESTATION_VERIFIER`. The only
one so far is `insecure-dev`, which believes evidence of the form `{ facts: PlatformFacts }`:
it is for VMs and tests, and the server warns at startup whenever it is set. The real one
(Keylime or Swiff's own: EK chain, AK credential activation, event-log replay, golden PCR 11)
comes in a later stage.

**Hardware floor (D3, open, provisional).** `HARDWARE_FLOOR` in `attestation.ts` is the one
setting. It requires UEFI, Secure Boot, a TPM 2.0 with an EK certificate and an IOMMU. A
firmware TPM hosts at `attested`, and a discrete TPM at the lower `attested-discrete-tpm`
tier. The tier is carried in the certificate, for matching to use later.

Not yet: revoking a certificate before it expires, the disk-key share
(`POST /machines/:id/state-key`), and rate-limiting the attestation routes per client, as
protection against load. A failed attempt does not use its challenge up (evidence that failed
fails again), so a flood of junk attempts cannot hold a machine's attestation back.

## Lifetimes

| Thing            | Lifetime                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session key      | 5 minutes from issue (`SESSION_KEY_TTL_SECONDS`). Checked only when registering: a streamer already registered keeps its socket after the key expires. |
| Host certificate | 10 minutes from attestation (`HOST_CERT_TTL_SECONDS`), and one session start. A socket registered with it is put out when it expires.                  |
| Session          | From start until the service ends it or the renter's platform session ends. Ending it and starting it again for the same `sessionId` issues a new key. |
| Everything       | Kept in the platform database (`key_sessions`, at `DATABASE_URL`). A restart keeps every live session, and its unexpired keys still register.          |

## Failure behaviour

| What happens                             | Result                                             | PC service does                                                            |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Streamer's socket drops, key still fresh | it reconnects and re-registers with the same key   | nothing                                                                    |
| Streamer's socket drops, key expired     | `denied bad-session-key`                           | `DELETE`, start the same `sessionId`, relaunch with the new key            |
| Streamer crashes                         | renter gets `peer-left`; room stays in the session | relaunch it; if the key has expired, `DELETE` and start first              |
| Service restarts and lost the session    | the old session is still live; start answers `409` | on startup, always `DELETE` first, then start the heartbeat's `session.id` |
| Signaling server restarts                | live sessions and their keys are kept              | nothing; the streamer reconnects with its key as after any drop            |
| Server cannot be reached for `DELETE`    | the room stays in the session; the streamer stays  | retry until `204`; stop the streamer locally meanwhile                     |
| `ROOM_SECRET` not set on the server      | every call `503 not-configured`                    | report the machine unavailable                                             |

Never pass the machine key to the streamer, write it into the renter's profile, or log it,
the session key or the ticket. The session key is harmless outside its room and after its
session ends, but within them it opens the room.

## Out of scope here

The Windows service and the streamer themselves, input, booking.
