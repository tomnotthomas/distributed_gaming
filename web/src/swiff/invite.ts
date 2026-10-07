// A crew's link (server/src/platform.ts, crews), and the invite a friend opens
// from it; the rest of crews is in crews.ts. The link is the
// whole credential for joining, so it is never sent to analytics (every event
// passes withoutInviteTokens first) or the console, and is kept out of the
// address bar and the Steam sign-in round trip: the invite page remembers it
// in this tab, puts /invite in the address instead, and comes back there from
// sign-in. Only with storage blocked does it stay in the path.

import type { CrewView, Rsvp } from "./crews";
import { STEAM_LOGIN_URL } from "./steam";

/** Someone in the crew as its invite shows them: persona, whether they founded it, their answer to its Zockrunde. */
export type InviteGuest = { name: string | null; admin: boolean; rsvp: Rsvp | null };

/** An invite as the friend opening it sees it: the crew, whether they are in it already, and who is in it. */
export type OpenedInvite = CrewView & { member: boolean; guests: InviteGuest[] };

/** Where invite links point: /invite/<token>. */
export const INVITE_PATH = "/invite";

/** Where this tab keeps the token of the invite it is signing in for. */
const PENDING_KEY = "swiff.invite";
/** Set while this tab is away at Steam to join that invite, to the answer to give: only then does coming back join. */
const JOINING_KEY = "swiff.inviteJoin";

/** The link a token makes, on this site. */
export const inviteLink = (token: string, origin: string = location.origin) =>
  `${origin}${INVITE_PATH}/${token}`;

/** The token in an invite path, "" for /invite itself, or null for any other path. */
export function inviteTokenAt(pathname: string): string | null {
  const match = /^\/invite(?:\/([\w-]+))?\/*$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}

/** An invite or seat link's token in a URL, plain or encoded as a sign-in's return. */
const TOKEN_IN_URL = /(\/|%2F)(invite|seat)(?:\/|%2F)[\w-]+/gi;

/**
 * `value` with every invite link in it cut back to /invite, and every friend
 * seat's link (seat.ts) to /seat, however deep: an analytics event's URLs,
 * referrer, person properties and clicked links alike.
 */
export function withoutInviteTokens<T>(value: T): T {
  if (typeof value === "string") return value.replace(TOKEN_IN_URL, "$1$2") as T;
  if (Array.isArray(value)) return value.map(withoutInviteTokens) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutInviteTokens(v)])) as T;
  }
  return value;
}

/** Remember the invite this tab is signing in for; false when storage is blocked. */
export function rememberInvite(token: string): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** The invite this tab was signing in for, or "" when there is none. */
export function rememberedInvite(): string {
  try {
    return sessionStorage.getItem(PENDING_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Note that this tab is going to Steam to join the invite it remembers,
 * answering its Zockrunde with `rsvp` (null: no answer); false when storage is blocked.
 */
export function meanToJoin(rsvp: Rsvp | null = null): boolean {
  try {
    sessionStorage.setItem(JOINING_KEY, rsvp ?? "join");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this tab went to Steam to join, and with which answer: "yes" or
 * "no" to the crew's Zockrunde, "join" for none, null when it did not go to
 * join. It counts once: reading it clears it, so a reload or Back never joins again.
 */
export function cameBackToJoin(): Rsvp | "join" | null {
  try {
    const set = sessionStorage.getItem(JOINING_KEY);
    sessionStorage.removeItem(JOINING_KEY);
    if (set === "yes" || set === "no") return set;
    // "1" is what a tab that went before answers were asked for kept.
    return set === "join" || set === "1" ? "join" : null;
  } catch {
    return null;
  }
}

/** Forget the invite this tab was signing in for, once it is joined. */
export function forgetInvite(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(JOINING_KEY);
  } catch {
    // Blocked storage held nothing.
  }
}

/**
 * Steam sign-in that comes back to the invite. With the token remembered in
 * this tab, the return is plain /invite, so the token never rides through
 * Steam; with storage blocked, it has to come back in the path.
 */
export function signInForInvite(token: string): string {
  const to = rememberInvite(token) ? INVITE_PATH : `${INVITE_PATH}/${token}`;
  return `${STEAM_LOGIN_URL}?to=${encodeURIComponent(to)}`;
}

/** The invite a token opens; "invalid" when the server says it opens nothing, null when it gave no answer. */
export async function openInvite(
  token: string,
  get: typeof fetch = fetch,
): Promise<OpenedInvite | "invalid" | null> {
  try {
    const response = await get(`/api/invites/${encodeURIComponent(token)}`);
    if (response.status === 404) return "invalid";
    return response.ok ? ((await response.json()) as { crew: OpenedInvite }).crew : null;
  } catch {
    return null;
  }
}

/**
 * Join the invite's crew as the signed-in player, answering its Zockrunde with
 * `rsvp` when it has one: the crew joined (`id` names it), or why not ("full":
 * in too many crews).
 */
export async function joinInvite(
  token: string,
  rsvp: Rsvp | null = null,
  get: typeof fetch = fetch,
): Promise<{ id: string; crew: CrewView; joined: boolean } | "invalid" | "full" | null> {
  try {
    const response = await get(`/api/invites/${encodeURIComponent(token)}/join`, {
      method: "POST",
      ...(rsvp ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ rsvp }) } : {}),
    });
    if (response.status === 404) return "invalid";
    // In as many crews as anyone may be: leaving one makes room.
    if (response.status === 409) return "full";
    return response.ok ? ((await response.json()) as { id: string; crew: CrewView; joined: boolean }) : null;
  } catch {
    return null;
  }
}

/**
 * The places a crew's page shares its link to. Discord and Signal take no
 * message to open, so it is copied for them; "share" is the phone's own share
 * sheet.
 */
export type Channel = "share" | "whatsapp" | "telegram" | "discord" | "signal";

/** What sharing to `channel` does: open a URL, or copy the message for the player to paste. */
export function shareTarget(
  channel: Exclude<Channel, "share">,
  message: string,
  link: string,
): { open: string } | { copy: string } {
  switch (channel) {
    case "whatsapp":
      return { open: `https://wa.me/?text=${encodeURIComponent(message)}` };
    case "telegram": {
      // Telegram puts the link above the text itself.
      const text = message.replace(link, "").trim();
      return {
        open: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
      };
    }
    case "discord":
    case "signal":
      return { copy: message };
  }
}
