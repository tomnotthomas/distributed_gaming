// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, session-claimed, peer-joined, answer, ice, launch-game,
//                        steam-login retry, peer-left
//   client  join     ──► joined, offer, ice, game-started, steam-login, peer-left, watchers,
//                        and from its watchers (watchId set): answer, ice, crew
//   viewer  watch    ──► watching, and from the player: offer, ice, crew
//   both    ping     ──► pong
//   either  refused  ──► denied, then the socket is closed with DENIED_CODE
//
// Watching (watch.ts): a crewmate of the renter playing asks to watch over
// HTTP and gets a watch ticket; with it their socket takes a viewer seat in
// the room. The renter's page (the player) says yes or no, and on yes it
// streams to the viewer itself, from the picture and sound it receives: the
// gaming PC never hears of a viewer, uploads nothing more for one, and no
// viewer frame ever reaches it.
//
// See access.ts for what `key`, `hostCert`, `sessionKey` and `ticket` are,
// attestation.ts for which of them may host, and
// docs/system-design/session-keys.md for how the PC gets a session key.

/**
 * Sent by the gaming PC to claim its room, with exactly one credential:
 *
 *   key         Its machine key. The phase-1 host app. Hosts only while
 *               hosting does not require attestation (`attestation-required`
 *               otherwise). Refused while the room is in a session
 *               (`session-active`), so it can never displace the streamer
 *               serving a renter.
 *   hostCert    A host certificate from attestation: swiff-hostd in Swiff OS.
 *               Otherwise exactly as the machine key: the PC service's socket.
 *   sessionKey  A session key for this room's live session. The streamer in
 *               the renter's Windows account, which must never hold the
 *               machine key. Replaces any host socket already in the room.
 *
 * A register with none of them, more than one, or one that is not a string is
 * refused: `bad-host-cert` if it names `hostCert`, else `bad-session-key` if it
 * names `sessionKey`, else `bad-machine-key`.
 *
 * `rental`, from the PC service only: true when the PC runs rental mode (Swiff
 * OS, whose renter signs in to Steam first), carried on its claims as
 * `rentalMode`. A socket registered with an attested host certificate is a
 * rental-mode PC whether or not it says so. Anything but a boolean is refused
 * as its credential would be.
 */
export type RegisterMessage =
  | { type: "register"; hostId: string; key: string; rental?: boolean; hostCert?: never; sessionKey?: never }
  | { type: "register"; hostId: string; hostCert: string; rental?: boolean; key?: never; sessionKey?: never }
  | { type: "register"; hostId: string; sessionKey: string; key?: never; hostCert?: never; rental?: never };

/** Sent by the renter to join a room. The room is the one the ticket names. */
export type JoinMessage = { type: "join"; ticket: string };

/**
 * Relayed verbatim between the two peers. The server never reads these.
 * `watchId` names a viewer: between the player and that viewer, never the PC.
 * The player sets it; on a viewer's frame the server sets it to the viewer's own.
 */
export type SdpMessage = { type: "offer" | "answer"; sdp: RTCSessionDescriptionInit; watchId?: string };
export type IceMessage = { type: "ice"; candidate: RTCIceCandidateInit; watchId?: string };

// --- Watching a crewmate play ------------------------------------------------

/** The most viewers one session takes, asking or watching. The player's page encodes one picture per viewer. */
export const MAX_WATCHERS = 4;

/** Sent by a viewer to take a viewer seat, with the watch ticket POST /api/crew/live/:id/watch gave. */
export type WatchMessage = { type: "watch"; ticket: string };

/**
 * The viewer's seat, as it stands: `asking` until the player says yes, then
 * `watching`. Sent on every change. `player` is the player's name when known;
 * `playerHere` whether their page is in the room to stream. `iceServers` as `joined`.
 */
export type WatchingMessage = {
  type: "watching";
  watchId: string;
  state: "asking" | "watching";
  player: string | null;
  playerHere: boolean;
  iceServers?: RTCIceServer[];
};

/** One viewer as the player sees them: who, whether they wait for a yes, and whether their page is here. */
export type Watcher = { watchId: string; name: string | null; state: "asking" | "watching"; here: boolean };

/**
 * To the player: everyone asking to watch or watching their session, whole,
 * on every change, and whether they share with their crew (anyone in it
 * watches without asking).
 */
export type WatchersMessage = { type: "watchers"; sharing: boolean; watchers: Watcher[] };

/** The player's yes or no to a viewer asking. */
export type WatchAnswerMessage = { type: "watch-answer"; watchId: string; accept: boolean };
/** The player stops a viewer watching. */
export type WatchStopMessage = { type: "watch-stop"; watchId: string };
/** The player opens their screen to their crew, or closes it again (closing stops nobody already watching). */
export type WatchShareMessage = { type: "watch-share"; open: boolean };

/** One person in the voice chat, as the viewer it is sent to sees them. */
export type VoicePerson = {
  /** "player", or a viewer's watchId. */
  id: string;
  name: string | null;
  /** The transceiver on the receiving viewer's own connection that carries their voice; null for the viewer themselves. */
  mid: string | null;
  /** In the voice chat, with a microphone. */
  inVoice: boolean;
  /** Muted by themselves. */
  muted: boolean;
  /** Muted by the player: nobody hears them until the player lets them speak again. */
  mutedByPlayer: boolean;
};

/**
 * The voice chat's own talk between the player and one viewer, relayed as is
 * between them (the server never reads `data`): the player sends who is in it
 * (`roster`), a viewer says whether it is in it and muted (`voice`).
 */
export type CrewSignal =
  { kind: "roster"; people: VoicePerson[] } | { kind: "voice"; inVoice: boolean; muted: boolean };
export type CrewMessage = { type: "crew"; watchId?: string; data: CrewSignal };

/**
 * Server acknowledgements and room events. `iceServers` in `joined` and
 * `peer-joined` carries the TURN relay when the server has one configured,
 * with a credential for that side of the renter's seat that expires with it
 * (ice.ts); clients add it to their default STUN.
 */
export type RegisteredMessage = { type: "registered"; hostId: string };
export type JoinedMessage = {
  type: "joined";
  hostId: string;
  hostOnline: boolean;
  iceServers?: RTCIceServer[];
};
/**
 * Why a register or join was refused, or why a registered host was hung up on.
 * The server closes the socket after it.
 *
 *   bad-machine-key  wrong machine key, or no such machine
 *   bad-host-cert    host certificate forged, expired, spent on a session start, or for
 *                    another room; also sent to a registered socket when its certificate expires
 *   attestation-required  a machine-key register while hosting requires attestation
 *   bad-session-key  forged, expired, for another room, or its session ended
 *   session-active   a machine-key or host-certificate register while the room is in a session
 *   session-ended    sent to a session-key host when its session is ended
 *   bad-ticket       renter's ticket forged or expired
 *   room-taken       another renter holds the seat
 *   replaced         sent to a renter socket a newer join with the same ticket took the seat from
 *   bad-watch-ticket a viewer's watch ticket forged, expired, or for a watch that is over
 *   watch-declined   the player said no
 *   watch-unanswered the player did not answer in time
 *   watch-stopped    the player stopped the viewer watching
 *   watch-ended      the session watched is over
 *   watch-left       the viewer left: a ticket for a watch they ended opens nothing
 *   watch-replaced   sent to a viewer socket a newer one with the same watch ticket took the seat from
 *   not-crew         the viewer and the player no longer share a crew
 */
export type DeniedMessage = {
  type: "denied";
  reason:
    | "bad-machine-key"
    | "bad-host-cert"
    | "attestation-required"
    | "bad-session-key"
    | "session-active"
    | "session-ended"
    | "bad-ticket"
    | "room-taken"
    | "replaced"
    | "bad-watch-ticket"
    | "watch-declined"
    | "watch-unanswered"
    | "watch-stopped"
    | "watch-ended"
    | "watch-left"
    | "watch-replaced"
    | "not-crew";
};
/**
 * Pushed to the PC service's socket (machine key or host certificate, never a
 * streamer's) the moment a renter claims its machine, so it need not wait for
 * its next heartbeat. It starts the host session
 * for exactly this `sessionId` (see the session API below). `appid` is the
 * Steam game booked; `minutes` the time booked.
 */
export type SessionClaimedMessage = {
  type: "session-claimed";
  sessionId: string;
  appid: number;
  minutes: number;
};
/**
 * Pushed to the room's host once the renter's first frame has arrived and their
 * page has started the session (POST /api/sessions/:id/start with the join
 * ticket): the PC launches `appid`, the game booked, and answers `game-started`
 * once it runs. Pushed again on every such start, so a host that already
 * launched the game only answers again.
 */
export type LaunchGameMessage = { type: "launch-game"; sessionId: string; appid: number };
/**
 * The host's answer to `launch-game`: the game runs. `sessionId` is the session
 * of the `launch-game` it answers. Relayed to the renter only when that is the
 * session their page started with their ticket, so a launch that outlived its
 * session never reaches the next renter. Their page shows the stream from here
 * on and not before, so it is sent only once the game's own window is what is
 * captured, never the desktop or Steam.
 */
export type GameStartedMessage = { type: "game-started"; sessionId: string };
/** Why a rental-mode PC's Steam sign-in or launch stopped short. */
export type SteamLoginFailure = "sign-in-timeout" | "launch-timeout";
/**
 * Rental mode's Steam sign-in, sent by the PC to its renter and relayed like
 * the handshake, never the other way. `qr` is the link Steam's own sign-in QR
 * code encodes, for the renter's page to draw as a QR code they scan with the
 * Steam app; the PC sends it again whenever Steam shows a new code.
 * `signed-in` says the renter approved it and the game is being launched.
 * `failed` says the sign-in or the launch stopped short: the renter is not
 * signed in and nothing is starting. Its `reason`, when the PC knows it, is
 * `sign-in-timeout` (Steam's code was never approved) or `launch-timeout` (the
 * game never came up after sign-in). The server never logs any of them.
 */
export type SteamLoginMessage =
  | { type: "steam-login"; state: "qr"; url: string }
  | { type: "steam-login"; state: "signed-in" }
  | { type: "steam-login"; state: "failed"; reason?: SteamLoginFailure };
/**
 * The one Steam sign-in message the other way: the renter asks the PC for a
 * fresh sign-in code after a `failed`, on the same claim. The renter keeps the
 * machine; nothing is ended or booked again.
 */
export type SteamLoginRetryMessage = { type: "steam-login"; state: "retry" };
export type PeerJoinedMessage = { type: "peer-joined"; iceServers?: RTCIceServer[] };
/**
 * The other side left the room. To the host, `grace` (seconds) says the renter
 * dropped mid-session and has that long to come back with the same seat before
 * the session ends as grace_expired (grace.ts): keep the game running, let go
 * of anything held. Without it the renter is not coming back.
 */
export type PeerLeftMessage = { type: "peer-left"; grace?: number };

/** Liveness. Required: Cloudflare closes an idle WebSocket after 100 seconds. */
export type PingMessage = { type: "ping" };
export type PongMessage = { type: "pong" };

export type SignalMessage =
  | RegisterMessage
  | JoinMessage
  | SdpMessage
  | IceMessage
  | RegisteredMessage
  | JoinedMessage
  | DeniedMessage
  | SessionClaimedMessage
  | LaunchGameMessage
  | GameStartedMessage
  | SteamLoginMessage
  | SteamLoginRetryMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PingMessage
  | PongMessage
  | WatchMessage
  | WatchingMessage
  | WatchersMessage
  | WatchAnswerMessage
  | WatchStopMessage
  | WatchShareMessage
  | CrewMessage;

/** Messages the server forwards to the other peer without inspecting them. */
export const RELAYED_TYPES = ["offer", "answer", "ice", "game-started", "steam-login", "crew"] as const;

/** Whether the server passes `msg` on to the other peer as is. */
export function isRelayed(
  msg: SignalMessage,
): msg is
  SdpMessage | IceMessage | GameStartedMessage | SteamLoginMessage | SteamLoginRetryMessage | CrewMessage {
  return (RELAYED_TYPES as readonly string[]).includes(msg.type);
}

// --- Host session API (HTTP) -------------------------------------------------
//
// Called by the background service on the gaming PC, never by the streamer or
// the browser. Authenticated as `Authorization: Bearer` with the machine key or
// a host certificate. Starting is hosting: with the machine key it is refused
// 403 attestation-required while hosting requires attestation. Ending is
// control too, so the machine key always may.
//
//   POST   /api/machines/:id/session  start  SessionStart → 201 SessionGrant
//                                            | 400 bad-request | 403 attestation-required
//                                            | 409 not-claimed | 409 session-active
//   DELETE /api/machines/:id/session  end    → 204, whether or not one was live
//
// Either answers 500 internal-error when the database fails; try again.
//
// A host session is the PC's side of the platform session a renter claimed,
// under the same id: start names it, and the platform ending it ends this too.
// Every refusal is a SessionError body. Full contract:
// docs/system-design/session-keys.md.

/**
 * The session API path with the machine id encoded as one path segment.
 * Throws URIError if `hostId` contains an unpaired surrogate.
 */
export const sessionPath = (hostId: string) => `/api/machines/${encodeURIComponent(hostId)}/session`;

/** What start is sent: the claimed platform session, from `session-claimed` or a heartbeat. */
export type SessionStart = { sessionId: string };

/** What start returns. */
export type SessionGrant = {
  /** The platform session the key is for: the one start named. */
  sessionId: string;
  /** Hand to the streamer; it sends it in `register`. */
  sessionKey: string;
  /** Unix seconds. After this the key registers nothing; end and start for another. */
  expiresAt: number;
};

export type SessionError = {
  error:
    | "bad-machine-key"
    | "bad-host-cert"
    | "attestation-required"
    | "bad-request"
    | "not-claimed"
    | "session-active"
    | "not-configured"
    | "not-found"
    | "internal-error";
};

// --- Attestation API (HTTP) --------------------------------------------------
//
// Called by swiff-hostd in Swiff OS to earn a host certificate; no other
// credential. See attestation.ts.
//
//   POST /api/machines/:id/attest-challenge  → 200 AttestChallengeGrant
//   POST /api/machines/:id/attest-activation  AttestActivationRequest → 200 AttestActivationGrant
//                                  | 400 bad-request | 401 bad-nonce | 403 attestation-refused
//                                  | 503 verifier-unavailable
//   POST /api/machines/:id/attest  AttestRequest → 200 HostCertGrant
//                                  | 400 bad-request (413 when too large) | 401 bad-nonce
//                                  | 403 attestation-refused | 503 verifier-unavailable
//
// Each answers 404 not-found for a machine with no key configured, and 503
// not-configured when the server has no ROOM_SECRET or no verifier, or (for
// attest-activation) a verifier that activates no AKs. The TPM verifier also
// takes the owner's registration of the machine's EK, with the machine key:
//
//   PUT /api/machines/:id/ek  EkRegistration → 204
//                             | 400 bad-request | 401 bad-machine-key
//                             | 403 attestation-refused (detail ek-untrusted) | 503 not-configured

/** A challenge to quote over. */
export type AttestChallengeGrant = {
  /** Opaque. The TPM quote's qualifying data is its SHA-256; send it back as is. */
  nonce: string;
  /** Unix seconds. Attest before this; each nonce earns one certificate at most. */
  expiresAt: number;
};

/** What attest-activation is sent: the challenge, and the AK that will quote over it. */
export type AttestActivationRequest = {
  nonce: string;
  /** Base64 TPM2B_PUBLIC of the AK, made under the EK. */
  akPublic: string;
};

/** TPM2_MakeCredential's outputs, base64, as TPM2_ActivateCredential (AK, EK) takes them. */
export type AttestActivationGrant = {
  /** TPM2B_ID_OBJECT. */
  credentialBlob: string;
  /** TPM2B_ENCRYPTED_SECRET. */
  encryptedSecret: string;
};

/** What attest is sent. `evidence` is the verifier's to read: quote, event log, EK certificate, AK proof. */
export type AttestRequest = { nonce: string; evidence: unknown };

/** The TPM verifier's `evidence`. Binary fields are base64. */
export type TpmEvidence = {
  /** TPM2B_PUBLIC of the AK, as sent to attest-activation. */
  akPublic: string;
  /** The credential TPM2_ActivateCredential recovered (TPM2B_DIGEST's buffer, without its size). */
  activation: string;
  /** TPMS_ATTEST from TPM2_Quote by the AK, qualifying data SHA-256(nonce), SHA-256 PCRs 0-7 and 11-13. */
  quote: string;
  /** TPMT_SIGNATURE over `quote`. */
  signature: string;
  /** Every quoted SHA-256 PCR's value, hex, by PCR number ("0" ... "13"). */
  pcrs: Record<string, string>;
  /** The firmware's TCG event log: /sys/kernel/security/tpm0/binary_bios_measurements. */
  eventLog: string;
};

/** The owner's registration of the machine's EK certificate, read from the TPM by its Windows. */
export type EkRegistration = {
  /** Base64 DER. */
  certificate: string;
  /** Base64 DER intermediates the TPM or its vendor supplied, if any. */
  intermediates?: string[];
};

/** What attest returns: the hosting credential. */
export type HostCertGrant = {
  /** Bearer for the hosting calls, and `hostCert` in `register`. Starts one host session at most. */
  hostCert: string;
  /** How far attestation trusts this machine (D3: a discrete TPM is a lower tier). */
  tier: "attested" | "attested-discrete-tpm";
  /** Unix seconds. A socket registered with it is put out then; attest again for a fresh one. */
  expiresAt: number;
};

/**
 * Why the TPM verifier refused evidence, in the order it checks (tpm-verifier.ts):
 *   malformed-evidence        not the TpmEvidence shape, or a structure that does not parse
 *   unknown-ek                no EK registered for the machine
 *   ek-untrusted              the EK certificate does not chain to a TPM vendor root
 *   ek-unsupported            the EK is not one of the TCG default templates' (RSA 2048, ECC P-256)
 *   ak-unsuitable             the AK is not a restricted signing key fixed to its TPM
 *   bad-signature             the quote is not the AK's
 *   wrong-nonce               the quote is not over this challenge
 *   ak-not-activated          the AK was not activated by the registered EK's TPM
 *   ak-not-under-ek           the AK is not a child of the EK
 *   pcrs-not-quoted           the quote does not cover SHA-256 PCRs 0-7 and 11-13
 *   pcr-digest-mismatch       the PCR values sent are not the ones quoted
 *   event-log-mismatch        the event log does not replay to PCRs 0-7
 *   unknown-boot-image        PCR 11 is no signed Swiff OS release's
 *   unknown-boot-extras       PCR 12 or 13 is not the release's: systemd-stub took a command line,
 *                             credential or extension from outside the UKI
 *   unknown-boot-application  something but the release's own boot chain ran, or it did not end
 *                             in the release's UKI (PCR 4)
 *   secure-boot-untrusted     PCR 7 shows Secure Boot keys not enrolled (setup mode), or an authority
 *                             the release does not list verified an image
 *   firmware-changed          firmware PCRs 0-3 changed, or the EK was registered again, and the
 *                             cooldown has not passed
 *   counter-rollback          the TPM's reset or restart count went back
 *   replayed-quote            the TPM's clock did not move on since the last accepted quote
 */
export type AttestRefusalDetail =
  | "malformed-evidence"
  | "unknown-ek"
  | "ek-untrusted"
  | "ek-unsupported"
  | "ak-unsuitable"
  | "bad-signature"
  | "wrong-nonce"
  | "ak-not-activated"
  | "ak-not-under-ek"
  | "pcrs-not-quoted"
  | "pcr-digest-mismatch"
  | "event-log-mismatch"
  | "unknown-boot-image"
  | "unknown-boot-extras"
  | "unknown-boot-application"
  | "secure-boot-untrusted"
  | "firmware-changed"
  | "counter-rollback"
  | "replayed-quote";

export type AttestRefusal = {
  error:
    | "bad-request"
    | "bad-nonce"
    | "attestation-refused"
    | "verifier-unavailable"
    | "not-found"
    | "not-configured";
  /** Why attestation-refused: the verifier rejected the evidence, or the hardware is below the floor. */
  reason?: "evidence-rejected" | "below-hardware-floor";
  /** What the verifier rejected, when it says (the TPM verifier always does). */
  detail?: AttestRefusalDetail;
};

// --- State key API (HTTP) ----------------------------------------------------
//
// Called by swiff-hostd in Swiff OS once per boot, right after attest, with
// `Authorization: Bearer <host certificate>` and no body. See state-key.ts.
//
//   POST /api/machines/:id/state-key  → 200 StateKeyGrant   the machine's share
//   PUT  /api/machines/:id/state-key  → 201 StateKeyGrant   a new share: the old one is gone
//
//   Either refuses with a StateKeyError:
//     401 bad-host-cert         not a host certificate for this machine, expired, or the
//                               machine is no longer configured
//     401 stale-host-cert       minted over STATE_KEY_FRESH_SECONDS ago, already used for a
//                               share, or not for the machine's latest attested boot: attest again
//     403 attestation-required  a machine key: the share goes only to an attested boot
//     403 revoked               the machine's state key is revoked
//     403 firmware-cooldown     the machine is waiting out a firmware cooldown
//     413 bad-request           a body over 32 KB (none is read)
//     429 rate-limited          with retry-after (seconds)
//     503 not-configured        no STATE_KEY_SECRET on the server
//     500 internal-error
//   POST alone:
//     404 no-state-key          none made yet: PUT
//     409 continuity-gap        something else booted since the last attested boot: PUT,
//                               and format the partition anew; the old share is never released

/** The server's share (V) of a machine's state partition key: it opens with U XOR share. */
export type StateKeyGrant = {
  /** Names the share; a new one has a new id. Keep it beside the sealed U to tell them apart. */
  keyId: string;
  /** Base64, 32 bytes. Held in memory only, never written or logged. */
  share: string;
};

export type StateKeyError = {
  error:
    | "bad-request"
    | "bad-host-cert"
    | "stale-host-cert"
    | "attestation-required"
    | "revoked"
    | "firmware-cooldown"
    | "no-state-key"
    | "continuity-gap"
    | "rate-limited"
    | "not-configured"
    | "internal-error";
};

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
