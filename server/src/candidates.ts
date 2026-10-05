// What a signed-in renter could play, and where: the machines ranked for one
// game (GET /api/games/:appid/machines) and how many are free for each game on
// the wall (GET /api/availability). Both run @swiff/rank's rank() over the
// machines on offer, so the wall's count and the game page's list agree.
//
// Latency is estimated through the server, for every machine: the renter's
// round trip to the server, as the page measured it, plus the host's, as its
// report last said. The real path between the two is usually shorter, so the
// estimate is an upper bound; it cannot tell a direct path from a relayed one.
// Nothing about where a host is (its address) is ever stored, let alone sent:
// a renter learns a machine's id, name, hardware, terms and the scores, never
// its owner. Direct probes of the top few are a later step.
//
// Pure: platform.ts reads the rows, api.ts checks the request.

import {
  rank,
  sessionSpanMs,
  type Candidate,
  type Control,
  type Encoder,
  type PicturePref,
  type Reason,
  type RenterPrefs,
  type Stability,
} from "@swiff/rank";
import { estimateLink, LIVENESS_MS, type OfferedMachine } from "./platform.js";
import type { Requirements } from "./requirements.js";

/** Who is asking: their Steam id, their round trip to the server, and their settings. */
export type RenterAsk = {
  steamId: string;
  /** The renter's round trip to the server in ms, as the page measured it. */
  rttMs: number;
  controls: Control[];
  picture: PicturePref;
};

/** How a machine's latency was arrived at: through the server for now, direct probes later. */
export type Latency = { rttMs: number; jitterMs: number; source: "estimate" };

/** One machine as a renter sees it on the game page. */
export type MachineCandidate = {
  id: string;
  name: string | null;
  gpu: string;
  vramMb: number;
  ramMb: number;
  cpu: string;
  cores: number;
  encoders: Encoder[];
  refreshHz: number;
  controls: Control[];
  /** Cents per hour. */
  price: number;
  /** Unix ms the owner wants it back; null when they have not said. */
  availableUntil: number | null;
  /** Minutes until then; null when the owner has not said. */
  minutesLeft: number | null;
  /** Free for all of the minutes asked for. */
  coversSession: boolean;
  latency: Latency;
  /** rank()'s scores: Response and Picture 1-4, the seven-day bucket, GPU headroom over the recommended card. */
  response: number;
  picture: number;
  stability: Stability;
  headroom: number;
};

/** A machine that would fit but is taken: when it is free again at the latest. */
export type BusyMachine = { id: string; name: string | null; backAt: number | null };

export type GameMachines = {
  appid: number;
  minutes: number;
  /** What the game was judged against, and where that came from (curated, Steam or the default). */
  requirements: Requirements;
  /** Best first. */
  machines: MachineCandidate[];
  /** Why the first beat the second; null with fewer than two. */
  reason: Reason | null;
  busy: BusyMachine[];
};

/** The machine a wall tile offers: enough to say where the game would run, and until when. */
export type WallMachine = {
  id: string;
  name: string | null;
  gpu: string;
  latency: Latency;
  /** Unix ms the owner wants it back; null when they have not said. */
  availableUntil: number | null;
};

/** One game's count on the wall. */
export type GameAvailability = {
  appid: number;
  /** Machines the renter could play it on right now. */
  free: number;
  /** Of those, the ones free for all of the minutes asked for; `free` when none were asked. */
  ready: number;
  /** The best of the `ready` ones, as the game page would rank it first; null when none is. */
  best: WallMachine | null;
  /** Machines that would fit but are taken. */
  busy: number;
  /** The soonest a busy one is free again (Unix ms); null when none is busy or none says. */
  backAt: number | null;
  /** That machine's name; null when there is none or it has no name. */
  backName: string | null;
};

/** Every machine with its estimated link from this renter. */
function candidatesFor(machines: OfferedMachine[], renter: RenterAsk): Candidate[] {
  return machines.map((m) => ({
    host: m.host,
    link: estimateLink(renter.rttMs, m.profile.net),
    history: m.history,
  }));
}

/** The renter as rank() reads them. */
function prefs(renter: RenterAsk, minutes: number): RenterPrefs {
  return { id: renter.steamId, controls: renter.controls, picture: renter.picture, sessionMinutes: minutes };
}

/**
 * Busy machines that will be free again while still offered, with `minutes`
 * left on the offer once they are, soonest first: one taken until after its
 * owner wants it back is not coming back tonight, and one back too late for
 * the session asked for would not fit it.
 */
function comingBack(
  later: Candidate[],
  byId: Map<string, OfferedMachine>,
  minutes: number,
): OfferedMachine[] {
  const fits = (backAt: number, host: OfferedMachine["host"]) =>
    backAt < host.availableUntil && backAt + sessionSpanMs(host, minutes) <= host.availableUntil;
  return later
    .map((c) => byId.get(c.host.id)!)
    .filter((m) => m.backAt === null || fits(m.backAt, m.host))
    .sort((a, b) => (a.backAt ?? Number.MAX_SAFE_INTEGER) - (b.backAt ?? Number.MAX_SAFE_INTEGER));
}

/** The time a ranked host is offered until, null for "until taken back". */
const untilOf = (host: { availableUntil: number }) =>
  host.availableUntil === Number.MAX_SAFE_INTEGER ? null : host.availableUntil;

/** The machines one renter could play `game` on for `minutes`, ranked, and the busy ones that would fit. */
export function machinesFor(
  game: Requirements,
  minutes: number,
  renter: RenterAsk,
  machines: OfferedMachine[],
  now: number,
): GameMachines {
  const byId = new Map(machines.map((m) => [m.host.id, m]));
  const result = rank(game, prefs(renter, minutes), candidatesFor(machines, renter), {
    now,
    heartbeatMaxAgeMs: LIVENESS_MS,
  });
  return {
    appid: game.appid,
    minutes,
    requirements: game,
    machines: result.hosts.map((h) => {
      const { profile } = byId.get(h.host.id)!;
      const hw = profile.hardware!; // E3 lists no machine without reported hardware
      const until = untilOf(h.host);
      return {
        id: h.host.id,
        name: profile.name,
        gpu: hw.gpu,
        vramMb: hw.vramMb,
        ramMb: hw.ramMb,
        cpu: hw.cpu,
        cores: hw.cores,
        encoders: hw.encoders,
        refreshHz: hw.display.refreshHz,
        controls: profile.controls,
        price: h.host.priceCentsPerHour,
        availableUntil: until,
        minutesLeft: until === null ? null : h.minutesLeft,
        coversSession: h.coversSession,
        latency: { rttMs: h.link.rttMs, jitterMs: h.link.jitterP95Ms, source: "estimate" },
        response: h.response,
        picture: h.picture,
        stability: h.stability,
        headroom: Math.round(h.headroom * 100) / 100,
      };
    }),
    reason: result.reason,
    busy: comingBack(result.later, byId, minutes).map((m) => ({
      id: m.host.id,
      name: m.profile.name,
      backAt: m.backAt,
    })),
  };
}

/**
 * Each game's count of free and busy machines for one renter, in the order
 * asked, with the best machine free for `minutes` (0: any free one) and the
 * one back soonest.
 */
export function availabilityFor(
  games: Requirements[],
  renter: RenterAsk,
  machines: OfferedMachine[],
  now: number,
  minutes = 0,
): GameAvailability[] {
  const byId = new Map(machines.map((m) => [m.host.id, m]));
  const candidates = candidatesFor(machines, renter);
  // How long the renter plays orders the list and says which are ready; it never decides who is on it.
  const renterPrefs = prefs(renter, minutes);
  return games.map((game) => {
    const result = rank(game, renterPrefs, candidates, { now, heartbeatMaxAgeMs: LIVENESS_MS });
    const ready = result.hosts.filter((h) => h.coversSession);
    const first = ready[0];
    // Any machine coming back counts, whatever the session: the wall says when, not whether it fits.
    const back = comingBack(result.later, byId, 0);
    return {
      appid: game.appid,
      free: result.hosts.length,
      ready: ready.length,
      best: first
        ? {
            id: first.host.id,
            name: byId.get(first.host.id)!.profile.name,
            gpu: first.host.gpu,
            latency: { rttMs: first.link.rttMs, jitterMs: first.link.jitterP95Ms, source: "estimate" },
            availableUntil: untilOf(first.host),
          }
        : null,
      busy: back.length,
      backAt: back[0]?.backAt ?? null,
      backName: back[0]?.profile.name ?? null,
    };
  });
}
