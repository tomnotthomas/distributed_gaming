// The renter page is served BY the signaling server, so its address is just
// the page's own origin: an https page gets wss, an http page gets ws. The
// Electron host has no such luck and asks the user — see desktop/.
export const SIGNALING_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// Phase 1 is one hardcoded room. A room per session replaces this once there
// is more than one gaming PC.
export const HOST_ID = "gaming-pc-1";
