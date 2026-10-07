// The PostHog project Lanterel Host reports its errors to, asked of the
// Lanterel server the owner set (GET /api/error-tracking, a public client key)
// and handed to main (mainErrors.ts), which checks it, keeps it for the next
// start and writes it onto Lanterel OS's ESP at install. Main hears which
// server is asked before it answers, so a new server's silence or failure
// never leaves the old server's project in place; the same server's failure
// keeps what it said last.

import { bridge } from "./bridge";

/** An answer still not in by then is given up; the next start asks again. */
export const ASK_TIMEOUT_MS = 10_000;

type Project = { key: string; host: string } | null;

/**
 * Tell main `origin` (https://...) is the server now, ask it for its project
 * and hand main the answer; false when there was none to hand.
 */
export async function syncErrorProject(
  origin: string,
  {
    ask = (url: string) => fetch(url, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) }),
    set = bridge()?.setErrorProject,
  }: { ask?: (url: string) => Promise<Response>; set?: (origin: string, project?: Project) => void } = {},
): Promise<boolean> {
  if (!set) return false;
  set(origin);
  try {
    const res = await ask(`${origin}/api/error-tracking`);
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (body !== null && typeof body !== "object") return false;
    set(origin, body as Project);
    return true;
  } catch {
    return false;
  }
}
