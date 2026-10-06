// The browser half of crews (server/src/platform.ts): the signed-in player's
// personal invite link, and the invite a friend opens from it. The link is the
// whole credential for joining, so it is never sent to analytics (every event
// passes withoutInviteTokens first) or the console, and is kept out of the
// address bar and the Steam sign-in round trip: the invite page remembers it
// in this tab, puts /invite in the address instead, and comes back there from
// sign-in. Only with storage blocked does it stay in the path.

import { STEAM_LOGIN_URL } from "./steam";

/** A crew as the server shows it: whose (their Steam persona, when known), and how many are in it. */
export type Crew = { name: string | null; own: boolean; size: number };

/** Someone in the player's own crew, by their Steam persona when known; `id` names the membership, never them. */
export type CrewMember = { id: string; name: string | null };

/** A crew the player joined, with `id` their membership in it. */
export type JoinedCrew = Crew & { id: string };

/** The signed-in player's link: its token, their crew and who is in it, and the crews they joined. */
export type MyInvite = { token: string; crew: Crew; members: CrewMember[]; joined: JoinedCrew[] };

/** An invite as the friend opening it sees it: the crew, and whether they are in it already. */
export type OpenedInvite = Crew & { member: boolean };

/** Where invite links point: /invite/<token>. */
export const INVITE_PATH = "/invite";

/** Where this tab keeps the token of the invite it is signing in for. */
const PENDING_KEY = "swiff.invite";

/** The link a token makes, on this site. */
export const inviteLink = (token: string, origin: string = location.origin) =>
  `${origin}${INVITE_PATH}/${token}`;

/** The token in an invite path, "" for /invite itself, or null for any other path. */
export function inviteTokenAt(pathname: string): string | null {
  const match = /^\/invite(?:\/([\w-]+))?\/*$/.exec(pathname);
  return match ? (match[1] ?? "") : null;
}

/** An invite link's token in a URL, plain or encoded as a sign-in's return. */
const TOKEN_IN_URL = /(\/|%2F)invite(?:\/|%2F)[\w-]+/gi;

/**
 * `value` with every invite link in it cut back to /invite, however deep: an
 * analytics event's URLs, referrer, person properties and clicked links alike.
 */
export function withoutInviteTokens<T>(value: T): T {
  if (typeof value === "string") return value.replace(TOKEN_IN_URL, "$1invite") as T;
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
 * Steam sign-in that comes back to the invite. With the token remembered in
 * this tab, the return is plain /invite, so the token never rides through
 * Steam; with storage blocked, it has to come back in the path.
 */
export function signInForInvite(token: string): string {
  const to = rememberInvite(token) ? INVITE_PATH : `${INVITE_PATH}/${token}`;
  return `${STEAM_LOGIN_URL}?to=${encodeURIComponent(to)}`;
}

/** The signed-in player's link, `renew` making a new one that replaces it; null when it cannot be had. */
export async function fetchMyInvite(
  { renew = false } = {},
  get: typeof fetch = fetch,
): Promise<MyInvite | null> {
  try {
    const response = await get(renew ? "/api/me/invite/renew" : "/api/me/invite", {
      method: renew ? "POST" : "GET",
    });
    return response.ok ? ((await response.json()) as MyInvite) : null;
  } catch {
    return null;
  }
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

/** Join the invite's crew as the signed-in player: the crew joined, or why not. */
export async function joinInvite(
  token: string,
  get: typeof fetch = fetch,
): Promise<{ crew: Crew } | "invalid" | "own" | null> {
  try {
    const response = await get(`/api/invites/${encodeURIComponent(token)}/join`, { method: "POST" });
    if (response.status === 404) return "invalid";
    if (response.status === 409) return "own";
    return response.ok ? ((await response.json()) as { crew: Crew }) : null;
  } catch {
    return null;
  }
}

/**
 * End a crew membership as the signed-in player: leave a crew they joined, or
 * remove someone from their own. One already gone counts as done.
 */
export async function removeCrewMember(id: string, get: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await get(`/api/crew-members/${encodeURIComponent(id)}/remove`, { method: "POST" });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** The places the card shares a link to. Discord and Steam chat take no link to open, so the message is copied for them. */
export type Channel = "share" | "whatsapp" | "discord" | "steam" | "email";

/** What sharing to `channel` does: open a URL, or copy the message for the player to paste. */
export function shareTarget(
  channel: Exclude<Channel, "share">,
  message: string,
  subject: string,
): { open: string } | { copy: string } {
  switch (channel) {
    case "whatsapp":
      return { open: `https://wa.me/?text=${encodeURIComponent(message)}` };
    case "email":
      return { open: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` };
    case "discord":
    case "steam":
      return { copy: message };
  }
}
