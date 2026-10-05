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
// Boot. Open the persistent state first: the server releases its share of the
// state's key only to a freshly attested boot (state-key.ts). Until it does, the
// PC stays off the market: no socket, no heartbeat, no offer, and the agent
// tries again, waiting longer each time. Then end any host session a crash left
// behind (its keys die), and ask the server where the machine stands. A renter
// already served in this same boot means the reset's reboot never happened:
// nobody is served or offered on it, and it restarts again, off offer unless a
// session is live. A session still live there is served at once. A machine off
// offer is one the agent paused before its reset reboot, and is offered again
// on the owner's terms; otherwise its owner stopped sharing it, and it goes
// back to Windows.
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
// host session, and reboot. The off-offer is the server's reset hold: a renter
// who claimed it in the instant before, even after the last heartbeat, is not
// turned away but held through the restart and served once the PC is back.

import type { MachineView, HostApi } from "./api.ts";
import { HostApiError } from "./api.ts";
import type { FloorCheck, OwnerTakeover } from "./config.ts";
import type { ResumeStore } from "./resume.ts";
import type { MachineSocket, SessionClaim, SocketEvent } from "./socket.ts";
import { StateKeyRefused, type StateUnlock } from "./state-key.ts";
import type { LaunchStreamer, Streamer } from "./streamer.ts";
import type { System } from "./system.ts";

export type Phase =
  "starting" | "unfit" | "locked" | "refused" | "offered" | "serving" | "resetting" | "returning";

/** How a run ended: the machine is restarting into rental mode, or into Windows. */
export type Outcome = "reset" | "windows";

export type AgentStatus = { phase: Phase; sessionId: string | null; unmet: FloorCheck[] };

/** The answer to the owner asking for the PC back. */
export type ReturnReply = { ok: true } | { ok: false; reason: "session-live" | "busy" };

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
  /** Waits between tries to open the persistent state; the last one repeats. */
  unlockRetryMs: readonly number[];
};

export const DEFAULT_TIMING: Timing = {
  sessionBeatMs: 5_000,
  offeredBeatMs: 30_000,
  offlineBeatMs: 5_000,
  maxStreamerStarts: 4,
  streamerSettledMs: 60_000,
  unlockRetryMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
};

export type AgentDeps = {
  api: HostApi;
  openSocket: (onEvent: (event: SocketEvent) => void) => MachineSocket;
  launchStreamer: LaunchStreamer;
  system: System;
  resume: ResumeStore;
  /** Opens the persistent state; none on a machine that has no state partition. */
  state?: StateUnlock;
  ownerTakeover: OwnerTakeover;
  timing?: Partial<Timing>;
  now?: () => number;
  log?: (message: string) => void;
};

export type Agent = {
  /** Run this boot to its end: resolves once the machine has been told to restart. */
  run(): Promise<Outcome>;
  status(): AgentStatus;
  /** The owner asks for the PC back (D8). Carried out at once while idle and no session shows; refused otherwise. */
  requestReturnToWindows(): Promise<ReturnReply>;
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
  /** The owner's request in hand, answered by the loop that holds the machine now. */
  let asked: ((reply: ReturnReply) => void) | null = null;
  const answer = (reply: ReturnReply) => {
    const pending = asked;
    asked = null;
    pending?.(reply);
  };

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
  async function boot(): Promise<SessionClaim | { sessionId: string } | "offer" | "unclean" | "windows"> {
    unmet = await system.unmetFloor();
    if (unmet.length) {
      phase = "unfit";
      log(`not offered: below the hardware floor (${unmet.join(", ")})`);
      while (!asked) await inbox.next(null);
      return "windows";
    }
    if (!(await unlockState())) return "windows";
    // A host session a crash left behind holds keys this boot never handed out.
    await endHostSession();
    let view = await beatUntilAnswered();
    const served = await resume.servedBoot();
    if (served !== null && served.bootId === (await system.bootId())) return "unclean";
    if (served !== null) await resume.forgetServed();
    // Kept on disk until the server has the machine on offer again: an agent
    // restarted while offerAgain() retries must still know the reset was its own.
    const resumed = await resume.read();
    if (view.session) {
      await resume.clear();
      return { sessionId: view.session.id };
    }
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
    await resume.clear();
    if (!sharing(view)) return "windows";
    return "offer";
  }

  /**
   * Open the persistent state, tried until it opens, waiting longer each time.
   * False when the owner asked for the PC back meanwhile.
   */
  async function unlockState(): Promise<boolean> {
    if (!deps.state) return true;
    for (let tries = 0; ; tries++) {
      let wait = timing.unlockRetryMs[Math.min(tries, timing.unlockRetryMs.length - 1)]!;
      try {
        await deps.state.unlock();
        if (tries) log("the persistent state is open");
        phase = "starting";
        return true;
      } catch (cause) {
        phase = "locked";
        log(`not offered: the persistent state did not open (${describe(cause)})`);
        // The server's own retry-after, when it says to wait longer.
        if (cause instanceof StateKeyRefused && cause.retryAfterMs) wait = Math.max(wait, cause.retryAfterMs);
      }
      if (!asked) await inbox.next(wait);
      if (asked) return false;
    }
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
        if (asked) {
          const outcome = await takeBack();
          if (outcome) return outcome;
          continue;
        }
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
   * The owner's request while offered: back to Windows when the server shows no
   * session, the PC then off offer; a session there is served. The off-offer
   * goes as a reset, so a claim that lands after the heartbeat is kept and
   * served rather than ended as the owner's. Null: ask again.
   */
  async function takeBack(): Promise<{ sessionId: string } | "windows" | null> {
    const view = await beat();
    if (view?.session) {
      answer({ ok: false, reason: "session-live" });
      return { sessionId: view.session.id };
    }
    if (view) {
      try {
        const off = await api.setAvailability(false, view.until ?? null, { reset: true });
        if (!off.session) return "windows";
        answer({ ok: false, reason: "session-live" });
        return { sessionId: off.session.id };
      } catch (cause) {
        if (refusal(cause)) throw new Refused("the server refused the machine key");
        log(`could not take the machine off offer: ${describe(cause)}`);
      }
    }
    answer({ ok: false, reason: "busy" });
    return null;
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
    await resume.markServed({ bootId: await system.bootId(), sessionId: id });

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
      if (asked && deps.ownerTakeover !== "always") answer({ ok: false, reason: "session-live" });
      if (asked) {
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
    if (!toWindows) answer({ ok: false, reason: "busy" });
    const view = await beat();
    if (view && !toWindows && sharing(view) && view.session?.id !== endedId) {
      const held = await offOfferForReset(view);
      if (held?.session) {
        log(
          `session ${held.session.id} was claimed as ${endedId} ended; it is held and served after the reset`,
        );
      }
    }
    await endHostSession();
    sessionId = null;
    if (toWindows || (view && !view.session && !sharing(view))) return returnToWindows();
    return restart();
  }

  /**
   * Off offer for the reset, remembered so the next boot offers it again on the
   * same terms. The server keeps a session claimed and not yet started, held
   * through the restart, and names it in the answer; a started one it ends.
   * Null when the server could not be told.
   */
  async function offOfferForReset(view: MachineView): Promise<MachineView | null> {
    try {
      // Saved first: a machine found off offer at boot with nothing saved goes back to Windows.
      await resume.save({ until: view.until ?? null });
      return await api.setAvailability(false, view.until ?? null, { reset: true });
    } catch (cause) {
      log(`could not take the machine off offer for the reset: ${describe(cause)}`);
      return null;
    }
  }

  /** Booted where a renter was served and no reboot came since: the reset again, from the start. */
  async function resetAgain(): Promise<Outcome> {
    phase = "resetting";
    log("a renter was served in this boot and it has not restarted since");
    const served = await resume.servedBoot();
    const view = await beatUntilAnswered();
    // A claim not yet served is held through the restart; the one this boot was
    // serving when the agent stopped is left to end as the host's, not the owner's.
    if (sharing(view) && view.session?.id !== served?.sessionId) await offOfferForReset(view);
    if (!view.session && view.status !== "idle" && !sharing(view)) return returnToWindows();
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
    answer({ ok: true });
    // Whatever a reset saved is not for the next time the owner shares.
    await resume.clear();
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
      let next: SessionClaim | { sessionId: string } | "offer" | "unclean" | "windows" = await boot();
      for (;;) {
        if (next === "windows") return await returnToWindows();
        if (next === "unclean") return await resetAgain();
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
      while (!asked) await inbox.next(null);
      return returnToWindows();
    }
  }

  return {
    run,
    status: () => ({ phase, sessionId, unmet }),
    requestReturnToWindows: async () => {
      if (phase === "returning") return { ok: true };
      if (phase === "starting" || phase === "resetting" || asked) return { ok: false, reason: "busy" };
      if (phase === "serving" && deps.ownerTakeover === "when-idle")
        return { ok: false, reason: "session-live" };
      const reply = new Promise<ReturnReply>((resolve) => (asked = resolve));
      inbox.push({ type: "wake" });
      return reply;
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
