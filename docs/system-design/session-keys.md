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
machine key, and still ends sessions with the machine key; it never attests itself. It
sends a certificate only over `wss:`/`https:` or to this machine, and refuses to start
otherwise. A
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

Once the renter's first frame has arrived, their page starts the session and the server
tells the streamer to launch the game booked:

```json
{ "type": "launch-game", "sessionId": "<platform session id>", "appid": 730 }
```

The streamer launches it and answers `{ "type": "game-started", "sessionId": "<the same id>" }`
once it runs, which the server relays to the renter only when that is the session their page
started with their ticket, so a launch that outlived its session never reaches the next
renter: until then the renter's page holds Ignition on Launching, past
90 s offering another machine, and shows none of the stream. Send it only once the game's
own window is what is being captured: the renter's first sight of the stream is the frame
after it, and must never be the desktop, the Steam library or any other Steam window. It is sent again on every first frame of a new connection, so launching
must be idempotent; a game already running is only answered again. Until the streamer
exists, `startHostSession`'s `launchGame` stands in for it, and with none nothing is
answered, so the renter stays on Launching. The desktop app has no launcher until the PC
session step, so it never answers until then; the web host page, a dev and test
responder, answers at once: the screen it shares stands in for the game.

The server also ends the host session whenever the renter's platform session ends
([`host.md`](host.md): the host ends it, the renter leaves, the booked time runs out, the
machine goes silent or the owner takes it back), exactly as `DELETE .../session` does. A
rental-mode PC taking itself off offer with `reset: true` to restart between renters is
not the owner taking it back: a session claimed the instant before, not yet started, is kept, held through
the restart, and its host session is started again once the PC is back
([`host.md`](host.md), the reset hold). The service must treat
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

`NVIDIA_RENTAL` switches hosting on NVIDIA cards in Swiff OS on (`on`) or off (`off`, the
default, and any unrecognised value) for every machine at once, without an app update. The
owner installs NVIDIA's driver themselves ([`swiff-os/NVIDIA.md`](../../swiff-os/NVIDIA.md)).
Attest's request says what the machine hosts on (`graphics`: `nvidia` or `other`); while the
switch is off, `nvidia` is refused `403 attestation-refused` with reason `nvidia-rental-off`,
and a host certificate minted for an NVIDIA machine hosts nothing (`bad-host-cert`), so its
running session stops at its next hosting call. `GET /api/hosting` (signed out) answers
`{ "nvidiaRental": false }` or `true`, for the host app to say so before the owner installs
anything. Sharing from Windows with the machine key is not affected.

A host certificate is a token the server signs with `ROOM_SECRET` under its own domain,
naming one room, its tier, an id of its own, when it was minted, the boot its quote counted
(see State key), whether the machine hosts on an NVIDIA card and an expiry ten minutes away. It is the PC
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
owner's Windows, once (machine key)
PUT  /api/machines/:id/ek  { certificate } ────► EK certificate must chain to a TPM vendor   (tpm verifier)
                                         ◄────── 204

swiff-hostd                                      server
POST /api/machines/:id/attest-challenge  ──────► 200 { nonce, expiresAt }       60 s, one certificate
POST /api/machines/:id/attest-activation ──────► TPM2_MakeCredential to the        (tpm verifier)
  { nonce, akPublic }                            registered EK for this AK
                                         ◄────── 200 { credentialBlob, encryptedSecret }
TPM2_ActivateCredential (AK, EK); TPM quote by
the AK with qualifying data SHA-256(nonce)
over PCRs 0-7, 11-13; the firmware event log
POST /api/machines/:id/attest            ──────► verifier judges the evidence, the hardware
  { nonce, evidence }                            floor picks the tier
                                         ◄────── 200 { hostCert, tier, expiresAt }
```

Refusals: `400 bad-request` (`413` with the same body when it is too large); `401 bad-nonce`
(forged, expired, another machine's, already used up by the attempt that earned a
certificate, or being judged in another attempt right now); `403 attestation-refused` with
`reason` `evidence-rejected` or `below-hardware-floor`, and with `evidence-rejected` the
verifier's `detail` when it gives one; `404 not-found` for a machine with no key; `503
verifier-unavailable` when the verifier itself fails; `503 not-configured` with no
`ROOM_SECRET` or no verifier (for `attest-activation` and `ek`, also a verifier that has no use
for them). Bodies are JSON with `cache-control: no-store`; the types are in `protocol.ts`.

The verifier sits behind the `AttestationVerifier` interface (`verify({ room, nonce, evidence, now })`
returning the platform facts it verified, or why not). It is picked with `ATTESTATION_VERIFIER`.
The attestation routes themselves take no other credential: the evidence is the proof.

**`tpm`, the production verifier** (`tpm-verifier.ts`). The owner's Windows registers the
TPM's EK certificate once, with the machine key; it must chain to a TPM vendor root. In Swiff
OS, `swiff-hostd` makes an AK under the EK, has the server make an activation credential for
it (TPM2_MakeCredential to the registered EK, keyed to this nonce, this AK and this EK, so the
server keeps no state between the calls), recovers it with TPM2_ActivateCredential, and quotes.
The evidence (`TpmEvidence` in `protocol.ts`) is judged in order, and the first failure is the
refusal's `detail`:

| Check                                                                                                                                                                                                                                                                                                                                       | `detail` when it fails                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| An EK is registered, its certificate still chains to a vendor root (the root's directory says firmware or discrete TPM), and its key is an RSA 2048 or ECC P-256 EK                                                                                                                                                                         | `unknown-ek`, `ek-untrusted`, `ek-unsupported` |
| The AK is a restricted signing key that never leaves its TPM                                                                                                                                                                                                                                                                                | `ak-unsuitable`                                |
| The AK signed the quote, over SHA-256 of this nonce                                                                                                                                                                                                                                                                                         | `bad-signature`, `wrong-nonce`                 |
| The AK was activated by the registered EK's TPM, and is a child of the EK (so the quote's counters are not obfuscated)                                                                                                                                                                                                                      | `ak-not-activated`, `ak-not-under-ek`          |
| The quote covers SHA-256 PCRs 0-7 and 11-13, and the PCR values sent are the quoted ones                                                                                                                                                                                                                                                    | `pcrs-not-quoted`, `pcr-digest-mismatch`       |
| The firmware event log replays to PCRs 0-7                                                                                                                                                                                                                                                                                                  | `event-log-mismatch`                           |
| PCR 11 is a released Swiff OS's, from the signed boot policy                                                                                                                                                                                                                                                                                | `unknown-boot-image`                           |
| PCRs 12 and 13 are that release's: systemd-stub took no command line, credential or extension from outside the UKI that the release does not expect                                                                                                                                                                                         | `unknown-boot-extras`                          |
| PCR 4 measured at least one application, everything in it is that release's boot chain, and the last one is the release's UKI                                                                                                                                                                                                               | `unknown-boot-application`                     |
| PCR 7 measured SecureBoot, PK, KEK, db and dbx, each once before its separator, with a platform key enrolled (not setup mode) whose whole variable record its digest binds, and every other extend of it, whatever type the log claims, is a known action or a Secure Boot authority the release lists. Never cooled down: refused outright | `secure-boot-untrusted`                        |
| PCRs 0-3 (firmware) are the ones the machine first attested with; a change, or any firmware after the EK was registered again, is refused until seen for 24 hours with Secure Boot on; a boot with Secure Boot off never sets, starts or accepts firmware                                                                                   | `firmware-changed`                             |
| The TPM's resetCount, restartCount and clock only go forward from the last accepted quote                                                                                                                                                                                                                                                   | `counter-rollback`, `replayed-quote`           |

What passes gives the platform facts: UEFI, Secure Boot and pre-boot DMA protection from the
replayed log, IOMMU from the release (a release declares it will not finish booting without
DMA remapping), and the TPM's kind from its EK root.
Per machine the server keeps the registered EK, the firmware baseline, a pending firmware change
and the last accepted counters, in the `machine_attestation` table, so a restart never makes
changed firmware look like a first use. The firmware baseline is the machine's, not its EK's.
Registering an EK again (the same one after the owner cleared the TPM, which sets its counters
back to zero, or another one) keeps the baseline and any pending change, forgets the counters,
and holds the firmware, even unchanged, for the 24-hour cooldown.

An event's type is not extended into its PCR, so the verifier never takes the type a log claims
on trust: every extend of PCRs 4 and 7 must be a separator, a known action or Secure Boot
variable whose data its digest binds, or else counts as a boot application (PCR 4) or an
authority (PCR 7) that the release must list.

The 24-hour cooldown only ever trusts changed firmware whose PCR 7 matches the policy and says
Secure Boot was on, so a key
the owner enrolled in db, verifying a driver of theirs, is refused however long it waits. The
verifier reports security events as one JSON line each on stderr (`[swiff] security event {...}`),
with the machine's id and PCR values only, never keys or evidence, for review and alerts:
`secure-boot-untrusted` (whether the keys were enrolled, and the authorities the release does
not list), every `firmware-changed` refusal (the baseline, the presented PCRs 0-3 and whether Secure Boot was on),
`firmware-accepted` when a change has cooled down (the previous and the accepted values), and
`ek-registered-again`.

It needs `ROOM_SECRET` (it keys the activation credentials) and:

- `ATTESTATION_TPM_ROOTS`: a directory of TPM vendor certificates, roots and intermediates, as
  PEM or DER, in `firmware/` (Intel PTT, AMD fTPM, Microsoft Pluton…) and `discrete/`
  (Infineon, STMicro, Nuvoton…), which host at the lower tier. Microsoft's TrustedTpm.cab is one
  source of them. For example `/etc/swiff/tpm-roots`.
- `ATTESTATION_POLICY` and `ATTESTATION_POLICY_KEY`: the signed boot policy file (which Swiff OS
  releases may host: their golden PCRs 11-13, boot applications, UKI and Secure Boot
  authorities; see `boot-policy.ts`)
  and the PEM public key that signs it (Ed25519, RSA or ECDSA), for example
  `/etc/swiff/boot-policy.json` and `/etc/swiff/boot-policy.pub.pem`. A policy without
  `pcr12`, `pcr13`, `uki` or `secureBootAuthorities` is refused. The release pipeline writes the payload (each release's PCR 11 from
  `systemd-measure calculate` at the `ready` phase, its PCRs 12 and 13, all zero unless it takes
  add-ons, credentials or extensions from the ESP, the Authenticode digests of shim, boot
  loader and UKI (every PCR 4 extend but the separator and the known actions), which of them is
  the UKI, every PCR 7 extend but the separator, the known actions and the first SecureBoot, PK,
  KEK, db and dbx before the separator (chiefly the Secure Boot authorities that verify the boot
  chain: Microsoft's UEFI CA 2023 or 2011, shim's vendor certificate or MOK; also, say, dbt where
  the firmware measures it), and whether it enforces an IOMMU) and signs it with
  `npm run boot-policy -- <payload.json> <private-key.pem>`.

Anything missing or wrong leaves no verifier, with a startup warning naming it. The tests
replay quotes a software TPM made: `server/scripts/tpm-fixtures.mjs` records them with swtpm.

**`insecure-dev`** takes evidence of the form `{ machineKey, facts: PlatformFacts, resetCount?,
countersRestarted? }`. The machine's own key stands in for the proof of who is asking, which the
TPM verifier gets from the machine's registered EK, so only its holder earns a certificate. The
facts, and the boot count for the state key, are believed as claimed. It is for VMs and tests, and the server warns at startup whenever it is set.

**Hardware floor (D3, open, provisional).** `HARDWARE_FLOOR` in `attestation.ts` is the one
setting. It requires UEFI, Secure Boot, a TPM 2.0 with an EK certificate and an IOMMU. A
firmware TPM hosts at `attested`, and a discrete TPM at the lower `attested-discrete-tpm`
tier. The tier is carried in the certificate, for matching to use later.

Not yet: revoking a certificate before it expires, binding the host certificate to a key inside the attested
system (a machine that relays challenges to another, untouched one is not caught), attestation
failures as a stability input, and rate-limiting the attestation routes per client, as
protection against load. A failed attempt does not use its challenge up (evidence that failed
fails again), so a flood of junk attempts cannot hold a machine's attestation back.

### State key

The rental state partition (the verified-file table, the host certificate cache, the Steam
client) is LUKS2, and its key is split in two, after Keylime's U and V shares
(`server/src/state-key.ts`):

| Share           | Made by                                                 | Kept                                                                               |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **U**, 32 bytes | `swiff-hostd`, at random, when it formats the partition | sealed to the TPM under the Swiff-signed PCR policy; never leaves the machine      |
| **V**, 32 bytes | the server, at random, per machine: the **state key**   | in `machine_state_keys`, encrypted with `STATE_KEY_SECRET`; released only as below |

The partition opens with **U XOR V**. The disk with its sealed U, copied off the machine, opens
nothing without V; V opens nothing without the TPM that sealed U. So a tampered system (it
cannot attest), a cloned one (another TPM, whose EK is not registered) or a revoked one never
unlocks it.

```
swiff-hostd, once per boot, right after attest                      server
POST /api/machines/:id/state-key  (Bearer host certificate) ──────► checks below
                                         ◄────── 200 { keyId, share }   open with U XOR share
                                         ◄────── 404 no-state-key       none yet  ─┐
                                         ◄────── 409 continuity-gap     withheld  ─┤
PUT  /api/machines/:id/state-key  (Bearer the same certificate) ◄──────────────────┘
                                         ◄────── 201 { keyId, share }   a new V; the old one is
                                                                        gone: format anew with a fresh U
```

Neither call has a body. `share` is base64, 32 bytes; `keyId` names it (a new share has a new
id), so `swiff-hostd` can keep it beside its sealed U and tell a partition made for an older
share. The types are `StateKeyGrant` and `StateKeyError` in `protocol.ts`; bodies are JSON with
`cache-control: no-store` and no CORS. `swiff-hostd` holds the share in memory only, long
enough to open the partition, and never writes or logs it.

A share is released only to a **host certificate** for this machine (`401 bad-host-cert`
otherwise, including one for a machine no longer in `MACHINE_KEYS`; the machine key gets `403
attestation-required`, whatever `HOSTING_ATTESTATION` says) that is:

- **fresh**: minted at most two minutes ago (`STATE_KEY_FRESH_SECONDS`), and not yet used for a
  share. One call that gets a share per attestation: a refused `POST` does not use it, so the
  `PUT` after a `404` or `409` takes the same certificate. Otherwise `401 stale-host-cert`:
  attest again.
- **for the machine's latest attested boot.** A host certificate names the boot its quote
  counted (the TPM's `resetCount`, which goes up by one at every boot) and when it was minted.
  Every attestation that passes records its boot first, and mints nothing if it cannot; a
  certificate from an earlier boot than the latest attested one is `401 stale-host-cert`.

And only while the machine is not revoked (`403 revoked`), not waiting out a firmware cooldown
(`403 firmware-cooldown`: changed firmware seen, or its EK registered again, see `tpm` above),
and within its budget: six calls at once, then one a minute (`429 rate-limited`, with
`retry-after` in seconds). `503 not-configured` without `STATE_KEY_SECRET`; `413 bad-request`
for a body over 32 KB; `500 internal-error` when the store fails or a share cannot be unsealed
(as after `STATE_KEY_SECRET` changed).

**Continuity.** A boot that follows the last attested one (the same boot again, or the next)
gets the share. Any other, or one the verifier could not count, means something else booted in
between (the owner's Windows, a live USB) and had the disk, so it may have been changed: the
share is withheld from then on (`409 continuity-gap`), through restarts and any number of
attestations, and only a `PUT` opens rental mode again, on a freshly formatted partition. A
rental-mode boot that attested but never asked for the share counts as a boot, so an
interrupted boot costs no state. The decision and the record of the boot are one database
statement, and the latest boot never goes back: an attestation of an earlier boot recorded late
(by another server process) changes nothing, and its certificate is stale. Only a TPM whose
counts started again (its EK registered again, as after the TPM was cleared) may count lower,
and that is a gap. A new share is written only while the boot it was asked for is still the
latest. Returning to Swiff OS after the owner used Windows is such a
gap: the state partition is formatted anew, and the games drive fully verified again.

**`swiff-hostd`, in order.** Attest. `POST` state-key. On `200`, open the partition with U XOR
share; if that fails (a `PUT` whose partition was never formatted), attest again and `PUT`. On
`404` or `409`, `PUT` with the same certificate, then format the partition with a fresh U
sealed to the TPM. On `401`, attest again. On `403 firmware-cooldown` or `revoked`, stay off
the market and show it on the status page. On `429` wait `retry-after`; on `5xx` retry with
backoff.

**Revoking.** `npm run state-key -- revoke <machine-id>` (on the database at `DATABASE_URL`)
destroys the machine's share at once, so its partition never opens again, and refuses it any
until `npm run state-key -- reinstate <machine-id>`, after which it may `PUT` a new one.
Taking the machine out of `MACHINE_KEYS` also refuses it (`401 bad-host-cert`).
A revocation takes effect at the database write: every call that reads the machine's row after
it is refused, and no write the server makes afterwards brings the share back. A `POST` that
had already read the row when the revocation landed may still answer with the share it read,
exactly as if it had come a moment earlier; no lock could recall a share already sent, so a
machine suspected of having its share is also taken out of `MACHINE_KEYS` and its partition
treated as compromised.

**Secrets.** `STATE_KEY_SECRET` (at least 32 characters, not `ROOM_SECRET`; for example
`openssl rand -base64 48`) derives the AES-256-GCM key each share is sealed with, bound to its
machine and key id, so a sealed share copied onto another machine's row opens nothing. Without
it every call answers `503 not-configured`, and the server warns at startup where a verifier
is set. Changing it makes every stored share unreadable: keep it as long as the shares. Shares
and the secret are never logged; replacing (`state-key-replaced`), revoking, reinstating and
withholding for a gap (`state-key-withheld`) are security events, one JSON line each on stderr
with the machine id, key ids and boot counts only.

Used certificates are kept in memory until they expire: a restart forgets them, so a
certificate that got a share just before one could get it again within its two minutes, for
the same boot of the same machine.

## Lifetimes

| Thing            | Lifetime                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session key      | 5 minutes from issue (`SESSION_KEY_TTL_SECONDS`). Checked only when registering: a streamer already registered keeps its socket after the key expires. |
| Host certificate | 10 minutes from attestation (`HOST_CERT_TTL_SECONDS`), and one session start. A socket registered with it is put out when it expires.                  |
| State key share  | Until replaced or revoked. Released only within 2 minutes of an attestation (`STATE_KEY_FRESH_SECONDS`), once per host certificate.                    |
| Session          | From start until the service ends it or the renter's platform session ends. Ending it and starting it again for the same `sessionId` issues a new key. |
| Everything       | Kept in the platform database (`key_sessions`, at `DATABASE_URL`). A restart keeps every live session, and its unexpired keys still register.          |

## Failure behaviour

| What happens                             | Result                                             | PC service does                                                            |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Streamer's socket drops, key still fresh | it reconnects and re-registers with the same key   | nothing                                                                    |
| Streamer's socket drops, key expired     | `denied bad-session-key`                           | `DELETE`, start the same `sessionId`, relaunch with the new key            |
| Streamer crashes                         | renter gets `peer-left`; room stays in the session | relaunch it; if the key has expired, `DELETE` and start first              |
| Service restarts and lost the session    | the old session is still live; start answers `409` | on startup, always `DELETE` first, then start the heartbeat's `session.id` |
| PC restarts before a claim is served     | with `reset: true`, the session is held 3 minutes  | `DELETE` before the restart; after it, start the heartbeat's `session.id`  |
| Signaling server restarts                | live sessions and their keys are kept              | nothing; the streamer reconnects with its key as after any drop            |
| Server cannot be reached for `DELETE`    | the room stays in the session; the streamer stays  | retry until `204`; stop the streamer locally meanwhile                     |
| `ROOM_SECRET` not set on the server      | every call `503 not-configured`                    | report the machine unavailable                                             |

Never pass the machine key to the streamer, write it into the renter's profile, or log it,
the session key or the ticket. The session key is harmless outside its room and after its
session ends, but within them it opens the room.

## Out of scope here

The Windows service and the streamer themselves, input, booking.
