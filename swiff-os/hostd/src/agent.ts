// swiff-hostd's agent: the "PC service" of docs/system-design/session-keys.md,
// as rental mode runs it. It holds the machine key, offers the PC, serves one
// renter session at a time through a streamer that only ever gets a short-lived
// session key, and after each session restarts the PC so the next renter gets a
// clean one (rental-mode report §5.2, §7).
//
//   boot ──► offered ──► serving ──► resetting ──► reboot (back into rental mode)
//    │         │                        │
//    └─────────┴──── returning ◄────────┘──► Windows first, reboot
//
// One run is one boot: it ends by handing the machine to a reboot.
//
// Boot. End any host session a crash left behind (its keys die), then ask the
// server where the machine stands. A reset saved in this same boot means its
// reboot never happened: the machine stays off offer and restarts again. A
// session still live there is served at once. A machine off offer is one the
// agent paused before its reset reboot, and is offered again on the owner's
// terms; otherwise its owner stopped sharing it, and it goes back to Windows.
//
// Offered. The machine-key socket holds the room and hears `session-claimed`.
// A heartbeat now and then also learns of a claim the socket missed, and of
// the owner ending sharing from elsewhere or the share-until passing.
//
// Serving. Start the claimed session's host session for its key, start the
// streamer with it, and beat every 5 s, which is also how the end is learned:
// the heartbeat no longer names the session. A streamer that exits while the
// session is still live is started again on a fresh key; only one that keeps
// stopping soon after it starts ends the session.
//
// Resetting. Take the machine off offer at once, so no renter is matched to a
// PC that is about to restart (D5: renters never wait for the reset), end the
// host session, and reboot. A renter who claimed it in the instant before is
// not turned away: the PC still restarts first, and serves them once it is back.

import type { MachineView, HostApi } from "./api.ts";
import { HostApiError } from "./api.ts";
import type { FloorCheck, OwnerTakeover } from "./config.ts";
import type { ResumeStore } from "./resume.ts";
import type { MachineSocket, SessionClaim, SocketEvent } from "./socket.ts";
import type { LaunchStreamer, Streamer } from "./streamer.ts";
import type { System } from "./system.ts";

export type Phase = "starting" | "unfit" | "refused" | "offered" | "serving" | "resetting" | "returning";

/** How a run ended: the machine is restarting into rental mode, or into Windows. */
export type Outcome = "reset" | "windows";

export type AgentStatus = { phase: Phase; sessionId: string | null; unmet: FloorCheck[] };

/** The answer to the owner asking for the PC back. */
export type ReturnReply = { ok: true } | { ok: false; reason: "session-live" };

export type Timing = {
  /** Between heartbeats while serving: the server takes a PC silent for 15 s offline. */
  sessionBeatMs: number;
  /** Between heartbeats while offered and the socket holds the room. */
  offeredBeatMs: number;
  /** Between heartbeats while offered and the socket is down: the heartbeat is the presence then. */
  offlineBeatMs: number;
  /** Streamer starts in a row, each stopping within `streamerSettledMs`, before the agent ends the session as broken. */
  maxStreamerStarts: number;
  /** A streamer that ran this long stopped for a reason of its own (an expired key), not as a failed start. */
  streamerSettledMs: number;
};

export const DEFAULT_TIMING: Timing = {
  sessionBeatMs: 5_000,
  offeredBeatMs: 30_000,
  offlineBeatMs: 5_000,
  maxStreamerStarts: 4,
  streamerSettledMs: 60_000,
};

export type AgentDeps = {
  api: HostApi;
  openSocket: (onEvent: (event: SocketEvent) => void) => MachineSocket;
  launchStreamer: LaunchStreamer;
  system: System;
  resume: ResumeStore;
  ownerTakeover: OwnerTakeover;
  timing?: Partial<Timing>;
  now?: () => number;
  log?: (message: string) => void;
};

export type Agent = {
  /** Run this boot to its end: resolves once the machine has been told to restart. */
  run(): Promise<Outcome>;
  status(): AgentStatus;
  /** The owner asks for the PC back (D8). Carried out as soon as no session is live. */
  requestReturnToWindows(): ReturnReply;
};

type Event =
  { type: "socket"; event: SocketEvent } | { type: "streamer-exit"; streamer: Streamer } | { type: "wake" };

/** The server refused the machine key: nothing the agent does will be accepted. */
class Refused extends Error {}

export function createAgent(deps: AgentDeps): Agent {
  const { api, system, resume } = deps;
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.log(`[swiff-hostd] ${message}`));

  let phase: Phase = "starting";
  let sessionId: string | null = null;
  let unmet: FloorCheck[] = [];
  /** The owner asked for the PC back, and it goes as soon as no session is live. */
  let returnWanted = false;

  const inbox = createInbox<Event>();

  /** Still to be offered: the owner has not stopped sharing, and the share-until has not passed. */
  const sharing = (view: MachineView) =>
    view.status !== "idle" && (view.until === undefined || view.until > now());

  /** The heartbeat, or null when it cannot be had now. A refused key is final. */
  async function beat(): Promise<MachineView | null> {
    try {
      return await api.heartbeat();
    } catch (cause) {
      if (refusal(cause)) throw new Refused("the server refused the machine key");
      log(`heartbeat failed: ${describe(cause)}`);
      return null;
    }
  }

  /** The heartbeat, tried every few seconds until the server answers. */
  async function beatUntilAnswered(): Promise<MachineView> {
    for (;;) {
      const view = await beat();
      if (view) return view;
      await inbox.next(timing.offlineBeatMs);
    }
  }

  /** Offer the machine again after the reset, tried every few seconds until the server answers. */
  async function offerAgain(until: number | null): Promise<MachineView> {
    for (;;) {
      try {
        return await api.setAvailability(true, until);
      } catch (cause) {
        if (refusal(cause)) throw new Refused("the server refused the machine key");
        log(`could not offer the machine again: ${describe(cause)}`);
      }
      await inbox.next(timing.offlineBeatMs);
    }
  }

  /** End the machine's host session, if any. Gives up after the API's own tries: a later boot ends it first. */
  async function endHostSession(): Promise<void> {
    try {
      await api.endHostSession();
    } catch (cause) {
      if (refusal(cause)) throw new Refused("the server refused the machine key");
      log(`could not end the host session: ${describe(cause)}`);
    }
  }

  /** The first boot step: whom to serve, or whether to offer or go back to Windows. */
  async function boot(): Promise<SessionClaim | { sessionId: string } | "offer" | "reset" | "windows"> {
    unmet = await system.unmetFloor();
    if (unmet.length) {
      phase = "unfit";
      log(`not offered: below the hardware floor (${unmet.join(", ")})`);
      while (!returnWanted) await inbox.next(null);
      return "windows";
    }
    // A host session a crash left behind holds keys this boot never handed out.
    await endHostSession();
    let view = await beatUntilAnswered();
    const resumed = await resume.take();
    if (resumed && resumed.bootId === (await system.bootId())) {
      log("the reset's reboot did not happen; restarting again");
      await resume.save(resumed);
      return "reset";
    }
    if (view.session) return { sessionId: view.session.id };
    if (view.status === "idle") {
      if (!resumed) {
        log("the owner is not sharing this PC");
        return "windows";
      }
      if (resumed.until !== null && resumed.until <= now()) {
        log("the share-until passed during the reset");
        return "windows";
      }
      view = await offerAgain(resumed.until);
    }
    if (!sharing(view)) return "windows";
    return "offer";
  }

  /** Hold the room with the machine key until a claim, or until the PC should go back to Windows. */
  async function offer(): Promise<SessionClaim | { sessionId: string } | "windows"> {
    phase = "offered";
    let registered = false;
    let socket = deps.openSocket((event) => inbox.push({ type: "socket", event }));
    try {
      for (;;) {
        const event = await inbox.next(registered ? timing.offeredBeatMs : timing.offlineBeatMs);
        if (event?.type === "socket") {
          const e = event.event;
          if (e.type === "registered") registered = true;
          else if (e.type === "offline") registered = false;
          else if (e.type === "claimed") return e.claim;
          else if (e.reason === "session-active") {
            // A session this boot does not know holds the room: end it, and
            // the server pushes its claim again when the key registers.
            socket.close();
            await endHostSession();
            registered = false;
            socket = deps.openSocket((ev) => inbox.push({ type: "socket", event: ev }));
          } else throw new Refused(`the server refused the machine key (${e.reason})`);
          continue;
        }
        if (returnWanted) return "windows";
        if (event) continue;
        const view = await beat();
        if (view?.session) return { sessionId: view.session.id };
        if (view && !sharing(view)) {
          log("the owner stopped sharing this PC, or its share-until passed");
          return "windows";
        }
      }
    } finally {
      socket.close();
    }
  }

  /**
   * Start the host session for `id` and the streamer with its key. Null when
   * the session is not this machine's to serve any more.
   */
  async function startStreamer(id: string, appid: number | null, again = false): Promise<Streamer | null> {
    let grant;
    try {
      grant = await api.startHostSession(id);
    } catch (cause) {
      if (refusal(cause)) throw new Refused("the server refused the machine key");
      // A host session of this one, left from before: end it for a fresh key, once.
      if (cause instanceof HostApiError && cause.code === "session-active" && !again) {
        await endHostSession();
        return startStreamer(id, appid, true);
      }
      if (cause instanceof HostApiError && cause.status < 500) return null;
      log(`could not start the host session: ${describe(cause)}`);
      return null;
    }
    const streamer = deps.launchStreamer(grant, appid);
    void streamer.exited.then(() => inbox.push({ type: "streamer-exit", streamer }));
    return streamer;
  }

  /** Serve one renter session to its end, then reset. */
  async function serve(claim: SessionClaim | { sessionId: string }): Promise<Outcome | "unclaimed"> {
    phase = "serving";
    const id = claim.sessionId;
    const appid = "appid" in claim ? claim.appid : null;
    sessionId = id;
    log(`serving session ${id}`);

    let starts = 1;
    let startedAt = now();
    let streamer = await startStreamer(id, appid);
    if (!streamer) {
      // Not claimed any more (or never started): no renter ran here.
      const view = await beat();
      if (!view?.session || view.session.id !== id) {
        sessionId = null;
        return "unclaimed";
      }
    }
    let takenBack = false;

    for (;;) {
      const event = await inbox.next(timing.sessionBeatMs);
      if (returnWanted && deps.ownerTakeover === "always") {
        // D8 "always": the owner takes it back, which ends the session as theirs.
        const view = await beat();
        await api.setAvailability(false, view?.until ?? null).catch((cause) => {
          log(`could not take the machine back: ${describe(cause)}`);
        });
        takenBack = true;
        break;
      }
      if (event?.type === "streamer-exit" && event.streamer !== streamer) continue;
      if (event && event.type !== "streamer-exit") continue;

      const view = await beat();
      if (view && view.session?.id !== id) break;
      if (event?.type === "streamer-exit" || (view && !streamer)) {
        if (event?.type === "streamer-exit" && now() - startedAt >= timing.streamerSettledMs) starts = 0;
        if (starts >= timing.maxStreamerStarts) {
          log(`the streamer keeps stopping; ending session ${id}`);
          await api.endSession(id).catch((cause) => log(`could not end the session: ${describe(cause)}`));
          break;
        }
        // A fresh key for a fresh streamer: the old one may have expired.
        starts++;
        await endHostSession();
        startedAt = now();
        streamer = await startStreamer(id, appid);
      }
    }

    await streamer?.stop();
    log(`session ${id} is over`);
    return reset(id, takenBack);
  }

  /** After a session: off offer at once, end the host session, restart clean. */
  async function reset(endedId: string, toWindows: boolean): Promise<Outcome> {
    phase = "resetting";
    const view = await beat();
    if (view?.session && view.session.id !== endedId) {
      log(`session ${view.session.id} was claimed as ${endedId} ended; it is served after the reset`);
    } else if (view && !view.session && !toWindows && !returnWanted && sharing(view)) {
      try {
        // Saved first: a machine found off offer at boot with nothing saved goes back to Windows.
        await resume.save({ until: view.until ?? null, bootId: await system.bootId() });
        await api.setAvailability(false, view.until ?? null);
      } catch (cause) {
        log(`could not take the machine off offer for the reset: ${describe(cause)}`);
      }
    }
    await endHostSession();
    sessionId = null;
    if (toWindows || returnWanted || (view && !view.session && !sharing(view))) return returnToWindows();
    return restart();
  }

  async function restart(): Promise<Outcome> {
    log("restarting for a clean PC");
    await system.reboot();
    return "reset";
  }

  /** Off offer, Windows first, restart. */
  async function returnToWindows(): Promise<Outcome> {
    phase = "returning";
    // Whatever a reset saved is not for the next time the owner shares.
    await resume.take();
    const view = await beat().catch(() => null);
    if (view && view.status !== "idle" && !view.session) {
      await api.setAvailability(false, view.until ?? null).catch((cause) => {
        log(`could not take the machine off offer: ${describe(cause)}`);
      });
    }
    log("going back to Windows");
    await system.returnToWindows();
    return "windows";
  }

  async function run(): Promise<Outcome> {
    try {
      let next: SessionClaim | { sessionId: string } | "offer" | "reset" | "windows" = await boot();
      for (;;) {
        if (next === "windows") return await returnToWindows();
        if (next === "reset") {
          phase = "resetting";
          return await restart();
        }
        if (next === "offer") {
          next = await offer();
          continue;
        }
        const served = await serve(next);
        if (served !== "unclaimed") return served;
        next = "offer";
      }
    } catch (cause) {
      if (!(cause instanceof Refused)) throw cause;
      phase = "refused";
      sessionId = null;
      log(`${cause.message}; not offered`);
      while (!returnWanted) await inbox.next(null);
      return returnToWindows();
    }
  }

  return {
    run,
    status: () => ({ phase, sessionId, unmet }),
    requestReturnToWindows: () => {
      if (phase === "serving" && deps.ownerTakeover === "when-idle")
        return { ok: false, reason: "session-live" };
      returnWanted = true;
      inbox.push({ type: "wake" });
      return { ok: true };
    },
  };
}

/** A 401 or 403: the machine key itself is refused. */
const refusal = (cause: unknown) =>
  cause instanceof HostApiError && (cause.status === 401 || cause.status === 403);

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Events in arrival order, and a wait for the next one with a timeout (null: no timeout). */
function createInbox<T>() {
  const queue: T[] = [];
  let waiter: ((event: T | null) => void) | null = null;
  return {
    push(event: T) {
      if (waiter) {
        const wake = waiter;
        waiter = null;
        wake(event);
      } else queue.push(event);
    },
    /** The next event, or null once `timeoutMs` passes without one. */
    next(timeoutMs: number | null): Promise<T | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => {
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                waiter = null;
                resolve(null);
              }, timeoutMs);
        waiter = (event) => {
          clearTimeout(timer);
          resolve(event);
        };
      });
    },
  };
}
