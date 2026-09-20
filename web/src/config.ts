// The file you edit.

// Same origin as the page, so there is nothing to configure and no
// mixed-content problem: an https page gets wss, an http page gets ws.
export const SIGNALING_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// Which machine to reach. Phase 1 is one hardcoded room; a room per session
// replaces this once there is more than one gaming PC.
export const HOST_ID = "gaming-pc-1";

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // { urls: "turn:HOST:3478", username: "USER", credential: "PASS" },
];

// Set true on BOTH peers to prove the relay path works. Needs TURN credentials
// above — with none, ICE finds no candidates at all and the connection fails.
export const FORCE_RELAY = false;

// Chrome ignores width/height/frameRate passed into getDisplayMedia, so the
// track is constrained after the fact instead.
export const CAPTURE = {
  width: 1920,
  frameRate: 60,
  maxBitrate: 10_000_000,
} as const;
