// The browser half of crews (server/src/platform.ts): founding one, reading
// the crews a player is in, and what a member does on a crew's page. A crew's
// link (/invite/<token>) is the whole credential for joining, so it is never
// sent to analytics or the console (invite.ts).

import { possessive, type CopyKey, type Lang, crewText } from "./crewCopy";
import { inviteLink } from "./invite";

/** Whether a crew can play: no PC plays for it, one is on offer, or every one is away. */
export type CrewState = "no-pc" | "ready" | "offline";

/**
 * A crew as a member, or a friend opening its link, sees it: its admin's Steam
 * persona (`name`), its own name if it has one, whether the viewer is its
 * admin, how many are in it, and its PCs.
 */
export type CrewView = {
  name: string | null;
  crewName: string | null;
  own: boolean;
  size: number;
  state: CrewState;
  pcs: number;
};

/** A crew the player is in: `id` names the crew, `memberId` their membership in it. */
export type MyCrew = CrewView & { id: string; memberId: string };

/** A crew in the player's list: `pcArrived` says its first PC came after they joined. */
export type ListedCrew = MyCrew & { pcArrived: boolean };

/** Someone in a crew; `id` names the membership, never them. `pcs` counts their PCs that play for it. */
export type CrewMember = {
  id: string;
  name: string | null;
  you: boolean;
  admin: boolean;
  pc: "yes" | "later" | null;
  pcs: number;
};

/** A PC playing for a crew. */
export type CrewPc = {
  name: string | null;
  owner: string | null;
  mine: boolean;
  state: "ready" | "busy" | "offline";
};

/** A crew in full, as its page shows it: `token` is its link's, null when it has none. */
export type CrewDetail = MyCrew & { token: string | null; members: CrewMember[]; machines: CrewPc[] };

/** Where crew pages live: /crews (your crews), /crews/new (found one), /crews/<id>. */
export const CREWS_PATH = "/crews";

/** What a crews path asks for: the list, founding one, or one crew by id; null for any other path. */
export function crewRouteAt(pathname: string): { crew: string | null; found: boolean } | null {
  const match = /^\/crews(?:\/([\w-]+))?\/*$/.exec(pathname);
  if (!match) return null;
  return match[1] === "new" ? { crew: null, found: true } : { crew: match[1] ?? null, found: false };
}

/** The crew's own name, or whose crew it is. */
export function crewTitle(lang: Lang, crew: Pick<CrewView, "name" | "crewName" | "own">): string {
  if (crew.crewName) return crew.crewName;
  if (crew.name) return possessive(lang, "crew.of", crew.name);
  return crewText(lang)(crew.own ? "crew.mine" : "crew.anon");
}

/** A PC as the crew calls it: whose it is, else its own name. */
export function pcTitle(lang: Lang, pc: Pick<CrewPc, "name" | "owner">): string {
  if (pc.owner) return possessive(lang, "pc.of", pc.owner);
  return pc.name || crewText(lang)("pc.anon");
}

/** The message a member shares the crew with: it invites, and while no PC is in it asks who has one. */
export function inviteMessage(lang: Lang, crew: CrewDetail, origin: string = location.origin): string {
  const t = crewText(lang);
  const link = crew.token ? inviteLink(crew.token, origin) : origin;
  const key: CopyKey =
    crew.state !== "no-pc" ? "msg.inviteReady" : crew.own ? "msg.invite" : "msg.inviteMember";
  return t(key, { crew: crewTitle(lang, crew), link });
}

/** A JSON call to the crew API: the answer's body, or the status it was refused with, or null for no answer. */
async function call<T>(
  path: string,
  init: RequestInit = {},
  get: typeof fetch = fetch,
): Promise<{ ok: true; body: T } | { ok: false; status: number | null }> {
  try {
    const response = await get(path, {
      ...init,
      ...(init.body ? { headers: { "content-type": "application/json" } } : {}),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, body: (await response.json()) as T };
  } catch {
    return { ok: false, status: null };
  }
}

/** The crews the signed-in player is in; null when they could not be read. */
export async function fetchCrews(get: typeof fetch = fetch): Promise<ListedCrew[] | null> {
  const answer = await call<{ crews: ListedCrew[] }>("/api/crews", {}, get);
  return answer.ok ? answer.body.crews : null;
}

const READY_SEEN_KEY = "swiff.crewsReadySeen";

/** The crews whose first PC was celebrated in this browser until the player closed it. */
function readySeen(): string[] {
  try {
    const seen: unknown = JSON.parse(localStorage.getItem(READY_SEEN_KEY) ?? "[]");
    return Array.isArray(seen) ? seen.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The first crew whose first PC came while the player was away and this browser has not celebrated yet. */
export function unseenReady(crews: readonly ListedCrew[]): ListedCrew | undefined {
  const seen = readySeen();
  return crews.find((c) => c.pcArrived && !seen.includes(c.id));
}

/** Remember in this browser that the player closed the celebration of the crew's first PC. */
export function seeReady(crewId: string): void {
  const seen = readySeen();
  if (seen.includes(crewId)) return;
  try {
    localStorage.setItem(READY_SEEN_KEY, JSON.stringify([...seen, crewId]));
  } catch {
    // Blocked storage: the celebration is back on the next visit, which is harmless.
  }
}

/** Found a crew as the signed-in player; "full" when they are in as many crews as anyone may be, null when it could not be made. */
export async function createCrew(
  name: string | null = null,
  get: typeof fetch = fetch,
): Promise<CrewDetail | "full" | null> {
  const answer = await call<{ crew: CrewDetail }>(
    "/api/crews",
    { method: "POST", body: JSON.stringify(name ? { name } : {}) },
    get,
  );
  if (!answer.ok) return answer.status === 409 ? "full" : null;
  return answer.body.crew;
}

/** A crew the signed-in player is in; "gone" when it is not theirs to read (or not there), null for no answer. */
export async function fetchCrew(id: string, get: typeof fetch = fetch): Promise<CrewDetail | "gone" | null> {
  const answer = await call<{ crew: CrewDetail }>(`/api/crews/${encodeURIComponent(id)}`, {}, get);
  if (answer.ok) return answer.body.crew;
  return answer.status === 404 ? "gone" : null;
}

/** What a member changes on the crew's page: the crew as it then is, or null when it did not work. */
async function change(
  id: string,
  action: "name" | "link" | "pc",
  body: object | null,
  get: typeof fetch,
): Promise<CrewDetail | null> {
  const answer = await call<{ crew: CrewDetail }>(
    `/api/crews/${encodeURIComponent(id)}/${action}`,
    { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) },
    get,
  );
  return answer.ok ? answer.body.crew : null;
}

/** Give the crew its own name, as its admin; an empty one names it after its admin again. */
export const renameCrew = (id: string, name: string, get: typeof fetch = fetch) =>
  change(id, "name", { name }, get);

/** A new link for the crew in place of the old one, as its admin. */
export const renewCrewLink = (id: string, get: typeof fetch = fetch) => change(id, "link", null, get);

/** Bring the signed-in member's PCs to the crew ("yes"), put it off ("later"), or take them out ("off"). */
export const bringPc = (id: string, pc: "yes" | "later" | "off", get: typeof fetch = fetch) =>
  change(id, "pc", { pc }, get);

/** End a crew membership: leave a crew, or remove someone from one you are the admin of. One already gone counts as done. */
export async function removeCrewMember(id: string, get: typeof fetch = fetch): Promise<boolean> {
  const answer = await call<unknown>(
    `/api/crew-members/${encodeURIComponent(id)}/remove`,
    { method: "POST" },
    get,
  );
  return answer.ok || answer.status === 404;
}

/**
 * The signed-in player's reminders by email: the address they go to, whether
 * it confirmed, and, when its confirm mail was held back, when to ask again.
 */
export type Reminders = { email: string | null; confirmed: boolean; retryAt?: number };

/** The player's reminders; null when the server takes none (the marketing site is off) or gave no answer. */
export async function fetchReminders(get: typeof fetch = fetch): Promise<Reminders | null> {
  const answer = await call<Reminders>("/api/signups/reminders", {}, get);
  return answer.ok ? answer.body : null;
}

/** Send the reminders to `email` once it confirms (`email` null: stop them); the reminders after, or null when that failed. */
export async function saveReminders(
  email: string | null,
  lang: Lang,
  get: typeof fetch = fetch,
): Promise<Reminders | null> {
  const answer = await call<Reminders>(
    email === null ? "/api/signups/reminders/off" : "/api/signups/reminders",
    { method: "POST", body: JSON.stringify(email === null ? {} : { email, lang }) },
    get,
  );
  return answer.ok ? answer.body : null;
}

/** Where this tab keeps that the player came from the host side, to see the PC card first. */
const PC_FIRST_KEY = "crew.pcFirst";

/**
 * What the address the marketing site's buttons land on asks for
 * (/crews?found=1&pc=1, server/scripts/import-launch-pages.mjs): found a crew
 * when the player has none yet (`found`), and show the PC card first (`pc`,
 * kept in this tab until a lobby shows it). Both leave the address.
 */
export function takeLanding(): { found: boolean } {
  const params = new URLSearchParams(location.search);
  const found = params.get("found") === "1";
  if (params.get("pc") === "1") {
    try {
      sessionStorage.setItem(PC_FIRST_KEY, "1");
    } catch {
      // Blocked storage: the lobby leads as it would anyway, which is harmless.
    }
  }
  if (params.has("found") || params.has("pc")) {
    params.delete("found");
    params.delete("pc");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
  }
  return { found };
}

/** Whether a lobby should open the PC card first, once: the player came from the host side. */
export function takePcFirst(): boolean {
  try {
    const first = sessionStorage.getItem(PC_FIRST_KEY) === "1";
    sessionStorage.removeItem(PC_FIRST_KEY);
    return first;
  } catch {
    return false;
  }
}
