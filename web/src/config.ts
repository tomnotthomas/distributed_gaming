// The renter page is served BY the signaling server, so its address is just
// the page's own origin: an https page gets wss, an http page gets ws. The
// Electron host has no such luck and asks the user — see desktop/.
export const SIGNALING_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// The room the browser host page (/host) registers. The renter never names a
// room: it joins whichever one its ticket opens.
export const HOST_ID = "gaming-pc-1";

/**
 * The renter's join ticket, from a link like `/rtc#ticket=…`. Carried in the
 * fragment so it never reaches a server log, a proxy or a Referer header.
 */
export function ticketFromUrl(hash = location.hash): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("ticket") ?? "";
}
