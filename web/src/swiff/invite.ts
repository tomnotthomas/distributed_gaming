// The browser half of crews (server/src/platform.ts): the signed-in player's
// personal invite link, and the invite a friend opens from it. The link is the
// whole credential for joining, so it is never sent to analytics or the
// console, and is kept out of the Steam sign-in round trip: the invite page
// remembers it in this tab while the friend signs in, and comes back to
// /invite without it.

import { STEAM_LOGIN_URL } from "./steam";

/** A crew as the server shows it: whose (their Steam persona, when known), and how many are in it. */
export type Crew = { name: string | null; own: boolean; size: number };

/** The signed-in player's link: its token, and their crew. */
export type MyInvite = { token: string; crew: Crew };

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
