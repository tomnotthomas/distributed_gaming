// The signaling wire format. Defined once and imported by both sides — the
// server relays these and the browser sends them, so a change here is a change
// to both or it is a bug.
//
//   host    register ──► registered, session-claimed, peer-joined, answer, ice, launch-game,
//                        steam-login retry, peer-left
//   client  join     ──► joined, offer, ice, game-started, steam-login, peer-left
//   both    ping     ──► pong
//   either  refused  ──► denied, then the socket is closed with DENIED_CODE
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
 */
export type RegisterMessage =
  | { type: "register"; hostId: string; key: string; hostCert?: never; sessionKey?: never }
  | { type: "register"; hostId: string; hostCert: string; key?: never; sessionKey?: never }
  | { type: "register"; hostId: string; sessionKey: string; key?: never; hostCert?: never };

/** Sent by the renter to join a room. The room is the one the ticket names. */
export type JoinMessage = { type: "join"; ticket: string };

/** Relayed verbatim between the two peers. The server never reads these. */
export type SdpMessage = { type: "offer" | "answer"; sdp: RTCSessionDescriptionInit };
export type IceMessage = { type: "ice"; candidate: RTCIceCandidateInit };

/**
 * Server acknowledgements and room events. `iceServers` carries the TURN relay
 * when the server has one configured; clients add it to their default STUN.
 */
export type RegisteredMessage = { type: "registered"; hostId: string; iceServers?: RTCIceServer[] };
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
    | "room-taken";
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
export type PeerJoinedMessage = { type: "peer-joined" };
export type PeerLeftMessage = { type: "peer-left" };

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
  | PongMessage;

/** Messages the server forwards to the other peer without inspecting them. */
export const RELAYED_TYPES = ["offer", "answer", "ice", "game-started", "steam-login"] as const;

export function isRelayed(
  msg: SignalMessage,
): msg is SdpMessage | IceMessage | GameStartedMessage | SteamLoginMessage | SteamLoginRetryMessage {
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

/**
 * Close code after `denied`. Clients stop reconnecting when they see `denied`:
 * retrying with the same credential gets the same answer, forever.
 */
export const DENIED_CODE = 4003;
