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
  session: CrewSession | null;
};

/** A crew's next Zockrunde: when it starts (Unix ms), and how many said they are in or cannot. */
export type CrewSession = { at: number; yes: number; no: number };

/** An answer to a crew's Zockrunde. */
export type Rsvp = "yes" | "no";

/** A crew the player is in: `id` names the crew, `memberId` their membership in it. */
export type MyCrew = CrewView & { id: string; memberId: string };

/** A crew in the player's list: `pcArrived` says its first PC came after they joined. */
export type ListedCrew = MyCrew & { pcArrived: boolean };

/**
 * Someone in a crew; `id` names the membership, never them. `pcs` counts their
 * PCs that play for it; `next` is the game (Steam appid) they are in line to
 * play next on the crew's PC, and since when.
 */
export type CrewMember = {
  id: string;
  name: string | null;
  you: boolean;
  admin: boolean;
  pc: "yes" | "later" | null;
  pcs: number;
  rsvp: Rsvp | null;
  next: { gameId: number; at: number } | null;
};

/** Someone in the crew playing on one of its PCs now; `starting` while still behind Ignition. */
export type CrewPcPlay = {
  sessionId: string;
  player: string | null;
  you: boolean;
  gameId: number;
  startedAt: number | null;
  starting: boolean;
};

/** A PC playing for a crew: `id` names the machine a game starts on, `playing` who plays on it now. */
export type CrewPc = {
  id: string;
  name: string | null;
  owner: string | null;
  mine: boolean;
  state: "ready" | "busy" | "offline";
  playing: CrewPcPlay | null;
};

/**
 * A crew in full, as its page shows it: `token` is its link's, null when it
 * has none; `shared` whether someone shared the invite since its Zockrunde was set.
 */
export type CrewDetail = MyCrew & {
  token: string | null;
  members: CrewMember[];
  machines: CrewPc[];
  shared: boolean;
};

/** Where crew pages live: /crews (your crews), /crews/<id>. */
export const CREWS_PATH = "/crews";

/** The crew pages founding a crew for a player who has none yet (takeLanding). */
export const FOUND_PATH = `${CREWS_PATH}?found=1`;

/** The crew pages founding another crew, however many the player is in (takeLanding). */
export const FOUND_NEW_PATH = `${CREWS_PATH}?found=new`;

/** What a crews path asks for: the list, or one crew by id; null for any other path. */
export function crewRouteAt(pathname: string): { crew: string | null } | null {
  const match = /^\/crews(?:\/([\w-]+))?\/*$/.exec(pathname);
  if (!match) return null;
  return { crew: match[1] ?? null };
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

/**
 * The message a member shares the crew with: it says the Zockrunde's date
 * first when there is one that is not over at `now` and who invites, asks everyone to say yes or no,
 * and while no PC is in it asks who has one.
 */
export function inviteMessage(
  lang: Lang,
  crew: CrewDetail,
  origin: string = location.origin,
  now: number = Date.now(),
): string {
  const t = crewText(lang);
  const link = crew.token ? inviteLink(crew.token, origin) : origin;
  const session = activeSession(crew, now);
  if (session) {
    const me = crew.members.find((m) => m.you);
    const lines = [
      t("msg.date", { when: sessionWhen(lang, session.at) }),
      me?.name ? t("msg.dateFrom", { name: me.name }) : t("msg.dateAnon"),
      link,
    ];
    if (crew.state === "no-pc") lines.push(t("msg.datePc"));
    return lines.join("\n");
  }
  const key: CopyKey =
    crew.state !== "no-pc" ? "msg.inviteReady" : crew.own ? "msg.invite" : "msg.inviteMember";
  return t(key, { crew: crewTitle(lang, crew), link });
}

/**
 * Where a Zockrunde's day and time are said: Germany's, wherever the browser
 * is, as the server's link preview says them (server/src/invite-copy.ts), so
 * one message never shows two times.
 */
export const SESSION_ZONE = "Europe/Berlin";

/** A moment's calendar day and time in SESSION_ZONE: `month` from 0, `weekday` from 0 for Sunday. */
export type ZonedTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const ZONED = new Intl.DateTimeFormat("en-US", {
  timeZone: SESSION_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `at` (Unix ms) as SESSION_ZONE's calendar and clock show it. */
export function zoned(at: number): ZonedTime {
  const parts = ZONED.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")) - 1,
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: WEEKDAYS.indexOf(part("weekday")),
  };
}

/** The moment (Unix ms) SESSION_ZONE's clock shows `hour`:`minute` on that calendar day (`month` from 0). */
export function zonedAt(year: number, month: number, day: number, hour: number, minute = 0): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let at = wall;
  // The zone's offset at the moment itself: twice, so a day that changes the clock settles too.
  for (let i = 0; i < 2; i++) {
    const shown = zoned(at);
    at += wall - Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute);
  }
  return at;
}

/** A date format in SESSION_ZONE, in the language's words. */
const sessionFormat = (lang: Lang, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", { ...options, timeZone: SESSION_ZONE });

/** The date of a Zockrunde (`at`, Unix ms) as a message says it: "Freitag, 9. Oktober, 21 Uhr", "Friday 9 October, 9 pm". */
export function sessionWhen(lang: Lang, at: number): string {
  return `${sessionDate(lang, at)}, ${sessionTime(lang, at)}`;
}

/** The day of a Zockrunde in full, in Berlin: "Freitag, 9. Oktober", "Friday 9 October". */
export function sessionDate(lang: Lang, at: number): string {
  return sessionFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(at);
}

/** The time of a Zockrunde as it is said: "21 Uhr", "21:30 Uhr", "9 pm", "9:30 pm". */
export function sessionTime(lang: Lang, at: number): string {
  const { hour, minute } = zoned(at);
  const mm = String(minute).padStart(2, "0");
  if (lang === "de") return `${minute ? `${hour}:${mm}` : hour} Uhr`;
  const twelve = hour % 12 || 12;
  return `${minute ? `${twelve}:${mm}` : twelve} ${hour < 12 ? "am" : "pm"}`;
}

/** The short day of a Zockrunde, as its ticket says it: "Fr 9. Okt", "Fri 9 Oct". */
export function sessionDay(lang: Lang, at: number): string {
  const parts = sessionFormat(lang, { weekday: "short", day: "numeric", month: "short" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value.replace(".", "") ?? "";
  return lang === "de"
    ? `${part("weekday")} ${part("day")}. ${part("month")}`
    : `${part("weekday")} ${part("day")} ${part("month")}`;
}

/** The weekday of a Zockrunde: short ("Fr", "Fri") or in full ("Freitag", "Friday"). */
export function sessionWeekday(lang: Lang, at: number, width: "short" | "long" = "short"): string {
  return sessionFormat(lang, { weekday: width }).format(at).replace(".", "");
}

/** A Zockrunde's start on the 24-hour clock, as its ticket and the time choices show it: "21:00". */
export function sessionClock(at: number): string {
  const { hour, minute } = zoned(at);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** How long after it starts a Zockrunde counts as over, and the next one is to be set: 6 hours. */
const SESSION_OVER_MS = 6 * 3600 * 1000;

/** The crew's Zockrunde while it is ahead or under way at `now`; null once it is over, or while it has none. */
export function activeSession(crew: Pick<CrewView, "session">, now: number): CrewSession | null {
  return crew.session && crew.session.at + SESSION_OVER_MS > now ? crew.session : null;
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
  action: "name" | "link" | "pc" | "session" | "rsvp" | "shared" | "next",
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

/** Bring the signed-in member's PCs to the crew ("yes"), or take them out ("off"). */
export const bringPc = (id: string, pc: "yes" | "off", get: typeof fetch = fetch) =>
  change(id, "pc", { pc }, get);

/** Set or move the crew's Zockrunde to start at `at` (Unix ms), as its admin. */
export const setCrewSession = (id: string, at: number, get: typeof fetch = fetch) =>
  change(id, "session", { at }, get);

/** Answer the crew's Zockrunde: in ("yes") or cannot ("no"). */
export const answerCrewSession = (id: string, rsvp: Rsvp, get: typeof fetch = fetch) =>
  change(id, "rsvp", { rsvp }, get);

/** Get in line to play `gameId` (a Steam appid) next on the crew's PC, or change the game; null leaves the line. */
export const queueNext = (id: string, gameId: number | null, get: typeof fetch = fetch) =>
  change(id, "next", { gameId }, get);

/** Who is in line to play next on the crew's PC, first in line first. */
export const crewQueue = (crew: Pick<CrewDetail, "members">): CrewMember[] =>
  crew.members.filter((m) => m.next).sort((a, b) => a.next!.at - b.next!.at);

/** Note that the signed-in member shared the crew's invite. */
export const sharedCrew = (id: string, get: typeof fetch = fetch) => change(id, "shared", null, get);

/** End a crew membership: leave a crew, or remove someone from one you are the admin of. One already gone counts as done. */
export async function removeCrewMember(id: string, get: typeof fetch = fetch): Promise<boolean> {
  const answer = await call<unknown>(
    `/api/crew-members/${encodeURIComponent(id)}/remove`,
    { method: "POST" },
    get,
  );
  return answer.ok || answer.status === 404;
}

/** Where this tab keeps that the player came from the host side, to see the PC card first. */
const PC_FIRST_KEY = "crew.pcFirst";

/**
 * What the address the crew pages open at asks for: found a crew when the
 * player has none yet (`found` "first", the marketing site's buttons:
 * /crews?found=1&pc=1, server/scripts/import-launch-pages.mjs), or found one
 * whatever they have ("new", the app's own "Start a new crew"), and show the
 * PC card first (`pc`, kept in this tab until a lobby shows it). Both leave
 * the address.
 */
export function takeLanding(): { found: "first" | "new" | null } {
  const params = new URLSearchParams(location.search);
  const asked = params.get("found");
  const found = asked === "1" ? "first" : asked === "new" ? "new" : null;
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
