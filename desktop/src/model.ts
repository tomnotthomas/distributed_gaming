// The host app's view-model: everything a screen shows, as one typed value,
// and the actions a screen can take. Two sources fill it:
//
//   useHost      this PC: its parts, Steam and its games, the connection
//                settings, what renters ask for and the live sharing session.
//                Whatever the platform does not report yet (reliability,
//                levels, the rate, earnings) is null, and the screens leave it out.
//   useDemoHost  the labelled demo data behind --demo, so every screen of the
//                design can be seen and walked. Never mixed with this PC's.

import type { Hardware as PcHardware, SteamGame } from "../pc.cjs";
import type { RunOutcome } from "../rental-exec.cjs";
import type { RentalPlan, RentalRead } from "../rental.cjs";
import type { RateMeter } from "./progress";
import type { SteamInstall, SteamStatus } from "../steam.cjs";
import { clock, euros, HOUR, inLabel, MINUTE } from "./format";
import type { Crew } from "./report";

export type Game = SteamGame;

/** What the app read about the PC, and its upload speed once the app has measured it. */
export type Hardware = PcHardware & { upMbps?: number | null };

/**
 * Players looking for a PC with a game in the last hour, across Swiff, and
 * how many of them wait in the queue now where the platform says.
 */
export type DemandRow = { appid: number; name: string; looking: number; waiting?: number };

// --- Steam on this PC -------------------------------------------------------------

export type { SteamInstall };

/** Valve's installer, once the owner asks for it: being fetched, open for them to click through, or why not. */
export type Installer =
  { kind: "idle" } | { kind: "fetching" } | { kind: "opened" } | { kind: "failed"; error: string };

/**
 * Steam on this PC. `status` is null until it has been read, and where the
 * app cannot read this PC. `installs` are the games Steam is installing;
 * `asked` the ones the owner sent to Steam that it has not started yet.
 */
export type SteamSetup = {
  status: Omit<SteamStatus, "path"> | null;
  installer: Installer;
  installs: SteamInstall[];
  asked: number[];
};

/** Steam is installed and signed in: games can be installed. */
export const steamReady = ({ status }: SteamSetup): boolean => Boolean(status?.installed && status.signedIn);

/** How far along an install is, from 0 to 1; null until Steam knows its size. */
export const installShare = ({ done, total }: SteamInstall): number | null =>
  total > 0 ? Math.min(1, done / total) : null;

/** The Steam appid in what the owner pasted: `730`, a store link, or a steam://install link. */
export function appidIn(text: string): number | null {
  const trimmed = text.trim();
  const match =
    /^(\d{1,10})$/.exec(trimmed) ??
    /^(?:https?:\/\/)?store\.steampowered\.com\/app\/(\d{1,10})(?:[/?#].*)?$/i.exec(trimmed) ??
    /^steam:\/\/install\/(\d{1,10})\/?$/i.exec(trimmed);
  const appid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(appid) && appid > 0 && appid < 2 ** 31 ? appid : null;
}

// --- rental mode on this PC -------------------------------------------------------

/** Where a step of the plan on screen is: not reached yet (absent), running, or past. */
export type StepState = "confirm" | "running" | "done" | "failed" | "stopped";

/** One pass over one of Swiff OS's files while it is written: the file, in the owner's words, and its own bytes. */
export type WritePass = {
  doing: "copying" | "writing" | "checking";
  name: string;
  done: number;
  total: number;
};

/**
 * The plan on screen, being run: each step's state, when the run and its
 * running step began, the running step's progress in bytes where it measures
 * them (with a meter of the rate, for the time left), and how it ended.
 * `restarting`: the owner said Restart now.
 */
export type RentalRun = {
  status: "idle" | "starting" | "running" | RunOutcome["status"] | "restarting";
  steps: Record<string, StepState>;
  startedAt: number | null;
  stepStartedAt: number | null;
  /** `done` of `total` moves only forward across the step and is no count of bytes; `pass` is. */
  progress: { id: string; done: number; total: number; pass: WritePass } | null;
  meter: RateMeter | null;
  failed: { step: string; error: string } | null;
  /** When it stopped, and when its details went to Swiff (Send details to Swiff). */
  endedAt: number | null;
  reportedAt: number | null;
};

export const IDLE_RUN: RentalRun = {
  status: "idle",
  steps: {},
  startedAt: null,
  stepStartedAt: null,
  progress: null,
  meter: null,
  failed: null,
  endedAt: null,
  reportedAt: null,
};

/**
 * Rental mode on this PC (rental.cjs): what Swiff OS needs from it, read
 * while `reading`; `read` is null until then, and where the app cannot read
 * this PC. `target` is the place for Swiff OS the owner chose, by id, null
 * for the best one. `preview` is the plan on screen, which `run` runs.
 */
export type RentalSetup = {
  reading: boolean;
  read: RentalRead | null;
  target: string | null;
  preview: RentalPlan | null;
  run: RentalRun;
  /** When `read` was read. */
  readAt?: number | null;
  /** A plan was asked for and has not come back yet: main reads the PC again first, which can take a while. */
  planning?: boolean;
  /** The end of the last live run the owner has seen summed up ("You were live"), shown once. */
  liveSeen?: number | null;
};

// --- standing, levels and the rate ---------------------------------------------

export type LevelId = "starter" | "steady" | "trusted" | "keystone";
export type Level = { id: LevelId; name: string; hours: number; bonus: number; perk: string };

/** Levels count reliable hours: hours in sessions that ran to their end. */
export const LEVELS: readonly Level[] = [
  { id: "starter", name: "Starter", hours: 0, bonus: 0, perk: "Hardware rate" },
  { id: "steady", name: "Steady", hours: 25, bonus: 0.05, perk: "+5% rate" },
  { id: "trusted", name: "Trusted", hours: 100, bonus: 0.1, perk: "+10% rate, Trusted host mark" },
  {
    id: "keystone",
    name: "Keystone",
    hours: 300,
    bonus: 0.15,
    perk: "+15% rate, listed first among equal PCs",
  },
];

/** The level reached after `hours` of reliable sharing. */
export const levelAt = (hours: number): Level =>
  [...LEVELS].reverse().find((l) => hours >= l.hours) ?? LEVELS[0]!;

/** The level after `level`; null at the top. */
export const nextLevel = (level: Level): Level | null => LEVELS[LEVELS.indexOf(level) + 1] ?? null;

/** How much of the hardware rate a seven-day reliability score keeps. */
export function reliabilityFactor(score: number): number {
  if (score >= 95) return 1;
  if (score >= 85) return 0.92;
  if (score >= 70) return 0.8;
  return 0.65;
}

/** The owner's seven-day standing with players. */
export type Standing = {
  reliability: number;
  /** The score before the last drop, while it recovers. */
  was: number | null;
  reliableHours: number;
  /** Sessions run to their end, of all sessions, over seven days. */
  finished: { done: number; of: number };
};

/** The rate, built in the open: hardware, times reliability, plus the level's bonus. */
export type Rate = { hardware: number; reliability: number; factor: number; level: Level; total: number };

/** The rate for `hardware`'s hourly base at `standing`. */
export function buildRate(hardware: number, standing: Standing): Rate {
  const level = levelAt(standing.reliableHours);
  const factor = reliabilityFactor(standing.reliability);
  const total = Math.round(hardware * factor * (1 + level.bonus) * 100) / 100;
  return { hardware, reliability: standing.reliability, factor, level, total };
}

/** "61 of 100 reliable hours to Trusted", and how far along the bar is. */
export function levelProgress(hours: number): {
  level: Level;
  next: Level | null;
  share: number;
  line: string;
} {
  const level = levelAt(hours);
  const next = nextLevel(level);
  if (!next) return { level, next, share: 1, line: `${Math.floor(hours)} reliable hours, the top level` };
  return {
    level,
    next,
    share: Math.min(1, hours / next.hours),
    line: `${Math.floor(hours)} of ${next.hours} hours to ${next.name}`,
  };
}

// --- earnings -------------------------------------------------------------------

export type Payout = { month: string; sessions: number; hours: number; amount: number };

export type Earnings = {
  /** Earned before the first payout. */
  earned: number;
  /** The smallest payout. */
  firstPayoutAt: number;
  nextPayout: string;
  accountEnding: string | null;
  month: { name: string; amount: number; sessions: number; hours: number };
  payouts: Payout[];
  /** Earned today, over `sessionsToday`. */
  today: number;
};

/** Every evening, from 18:00 to midnight. */
export const EVENING_HOURS = 6;

/** The most `now`'s month can pay at `rate`, live every evening of it: a ceiling, not a forecast. */
export function monthCeiling(rate: number, now: number): number {
  const d = new Date(now);
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return rate * EVENING_HOURS * days;
}

// --- the live session -----------------------------------------------------------

/**
 * A player's claim on this PC: the game, and the minutes booked from `at`.
 * `rate` is fixed for the session when it is claimed; null where there is none.
 */
export type Claim = { appid: number; name: string; minutes: number; at: number; rate: number | null };

export type Live =
  /** Not sharing. `note` says why sharing stopped on its own, when it did. */
  | { kind: "off"; note: string | null }
  /** Asking for the screen. */
  | { kind: "starting" }
  /** Sharing, no player yet. `registered` once Swiff has confirmed the room. */
  | { kind: "waiting"; since: number; until: number | null; registered: boolean }
  /** A player's session. `atPc`: someone is using this PC's keyboard or mouse. */
  | {
      kind: "session";
      since: number;
      until: number | null;
      claim: Claim;
      playerHere: boolean;
      stopNew: boolean;
      notify: boolean;
      atPc: boolean;
    }
  /** Ending early: the player has been warned and has the grace to save. Demo only. */
  | { kind: "ending"; until: number | null; claim: Claim; warnedAt: number }
  | { kind: "paused"; at: number }
  /** The connection to Swiff dropped while waiting; the app keeps retrying. */
  | { kind: "offline"; since: number; lastContact: number | null; until: number | null };

/** How long a warned player has to save. */
export const GRACE_MS = 5 * MINUTE;

/** When `claim`'s booked minutes run out, in ms. */
export const claimEnd = (claim: Claim): number => claim.at + claim.minutes * MINUTE;

/** The connection the app signs in with. */
export type Connection = {
  url: string;
  machineId: string;
  machineKey: string;
  /** The name players see; empty for the machine id. */
  name: string;
  /** Something to tell the owner about the key or the last attempt. */
  notice: string | null;
  /** The screen being captured, for the settings preview. */
  preview: MediaStream | null;
};

/** Whether the connection has everything signing in needs. */
export const connectionReady = (c: Pick<Connection, "url" | "machineId" | "machineKey">): boolean =>
  Boolean(c.url.trim() && c.machineId.trim() && c.machineKey.trim());

export type HostView = {
  demo: boolean;
  now: number;
  /** The name players see: the owner's, else the machine id. */
  machine: string;
  pc: { reading: boolean; hardware: Hardware | null; hardwareRate: number | null };
  /**
   * `offered`: the games the owner offers, null where the choice has no effect yet.
   * `near`: players looking for a PC near this one now. Both it and `demand` are null until the platform reports demand.
   */
  games: { installed: Game[]; offered: number[] | null; demand: DemandRow[] | null; near: number | null };
  steam: SteamSetup;
  rental: RentalSetup;
  standing: Standing | null;
  /** What ending a session early would leave the reliability score at; null where it cannot be done. */
  earlyEnd: { reliability: number } | null;
  rate: Rate | null;
  earnings: Earnings | null;
  live: Live;
  /** The share-until time Go live will use: null for "until I stop it". */
  plan: number | null;
  sessionsToday: number;
  connection: Connection;
  /** Payout details were saved, in the demo. The app never keeps them. */
  payoutSaved: boolean;
  /** Who may play on this PC, as the platform last said; null until it has. */
  crew: Crew | null;
};

export type TrayAction = "stop-new" | "allow-new" | "pause" | "resume" | "retry";

export type HostActions = {
  plan(until: number | null): void;
  goLive(): void;
  /** Change the end time while live. */
  setUntil(until: number | null): void;
  pause(): void;
  resume(): void;
  setStopNew(on: boolean): void;
  notifyAtEnd(): void;
  /** Ending early needs the platform to warn the player: demo only until it can. */
  endEarly: (() => void) | null;
  cancelEnd: (() => void) | null;
  retry(): void;
  /** Offer an installed game, or stop offering it; null until the games are read. */
  toggleOffer: ((appid: number) => void) | null;
  saveConnection(c: Pick<Connection, "url" | "machineId" | "machineKey" | "name">): Promise<void>;
  savePayout(): void;
  /** Download Valve's installer and open it for the owner. */
  installSteam(): void;
  /** The owner sent a game to Steam to install: follow it until Steam starts. */
  askInstall(appid: number): void;
  /** Read what rental mode needs from this PC again. */
  checkRental(): void;
  /** Where Swiff OS goes, by target id. */
  chooseRentalTarget(id: string): void;
  /** Show the steps that install rental mode, remove it or its key, switch to it or confirm its key again. */
  previewRental(kind: RentalPlan["kind"]): void;
  closeRentalPreview(): void;
  /** Offer this PC to its owner's crew only, or to anyone. */
  setCrewOnly(on: boolean): void;
  /** Run the plan on screen, the owner's one OK: Windows asks once for administrator rights. */
  runRental(): void;
  /** Restart now, after a run that ended at its restart, or with Swiff's key queued. */
  restartRental(): void;
  /** Whether the blue screen took the key's code, in the owner's words. */
  answerRentalKey(yes: boolean): void;
  /** Go live in rental mode: the PC restarts into Swiff OS. */
  goLiveRental(): void;
  /** Try a failed plan again: planned afresh and run at once, the owner's OK given already. */
  retryRental(): void;
  /** Send details to Swiff: the failed step, its error and this PC's checks. */
  reportRental(): void;
  /** The owner has seen the last live run summed up. */
  seenLastLive(): void;
};

export type Host = { view: HostView; actions: HostActions };

// --- share until ----------------------------------------------------------------

export type UntilChoice = { at: number | null; time: string; label: string };

/**
 * The four share-until choices: about 2, 4 and 10 hours from now on the hour,
 * and open. Each label says exactly how far off its time is.
 */
export function untilChoices(now: number): UntilChoice[] {
  const onTheHour = (hours: number) => {
    const d = new Date(now + hours * HOUR);
    if (d.getMinutes() >= 30) d.setHours(d.getHours() + 1);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  };
  return [
    ...[2, 4, 10].map((h) => {
      const at = onTheHour(h);
      return { at, time: clock(at), label: inLabel(at - now) };
    }),
    { at: null, time: "Open", label: "until I stop" },
  ];
}

/** The next time the clock reads `hhmm` ("00:30"), from `now`; null for anything else. */
export function nextAt(hhmm: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  if (h > 23 || m > 59) return null;
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** One sentence on what the chosen end time means. */
export function untilSentence(machine: string, until: number | null): string {
  const window = until === null ? "until you stop" : `until ${clock(until)}`;
  return `Players can book ${machine} ${window}. A session that starts before then runs to its end.`;
}

// --- screens --------------------------------------------------------------------

export type Step = "pc" | "steam" | "games" | "rental" | "live" | "paid" | "settings";

/** Which of the Go live step's screens a live state shows. */
export type LiveScreen = "golive" | "waiting" | "streaming" | "inuse" | "ending" | "paused" | "offline";

/** The screen `live` shows. */
export function liveScreen(live: Live): LiveScreen {
  switch (live.kind) {
    case "off":
    case "starting":
      return "golive";
    case "waiting":
      return "waiting";
    case "session":
      return live.atPc ? "inuse" : "streaming";
    case "ending":
      return "ending";
    case "paused":
      return "paused";
    case "offline":
      return "offline";
  }
}

/** What a session has earned by `now`, at the rate fixed when it was claimed: only where there is one. */
export const sessionEarned = (claim: Claim, now: number): number | null =>
  claim.rate === null ? null : (claim.rate * Math.max(0, Math.min(now, claimEnd(claim)) - claim.at)) / HOUR;

// --- the tray glance ------------------------------------------------------------

/** What the tray glance shows, sent from the main window as a plain snapshot. */
export type Glance = {
  demo: boolean;
  /** One short line: "Live until 01:00", "Paused at 21:31", "Offline", "Not sharing". */
  status: string;
  live: boolean;
  game: { appid: number; caption: string } | null;
  figure: { amount: string; label: string } | null;
  action: { id: TrayAction; label: string } | null;
  foot: string;
};

/** The tray glance's snapshot of `view`. */
export function glanceOf(view: HostView): Glance {
  const { live, now } = view;
  const foot =
    view.standing && view.rate
      ? `Reliability ${view.standing.reliability}, ${view.rate.level.name}`
      : view.machine;
  const until = (u: number | null) => (u === null ? "Live" : `Live until ${clock(u)}`);
  const base = { demo: view.demo, live: false, game: null, figure: null, action: null, foot };
  switch (live.kind) {
    case "waiting":
      return {
        ...base,
        status: until(live.until),
        live: true,
        action: { id: "pause", label: "Pause" },
      };
    case "session":
    case "ending": {
      const earned = sessionEarned(live.claim, live.kind === "ending" ? live.warnedAt : now);
      const caption =
        live.kind === "ending"
          ? `${live.claim.name}, ending early`
          : `${live.claim.name}, booked until ${clock(claimEnd(live.claim))}`;
      return {
        ...base,
        status: until(live.until),
        live: true,
        game: { appid: live.claim.appid, caption },
        figure: earned === null ? null : { amount: euros(earned), label: "this session" },
        action:
          live.kind === "ending"
            ? null
            : live.stopNew
              ? { id: "allow-new", label: "Allow new bookings" }
              : { id: "stop-new", label: "Stop new bookings" },
      };
    }
    case "paused":
      return {
        ...base,
        status: `Paused at ${clock(live.at)}`,
        action: { id: "resume", label: "Resume" },
      };
    case "offline":
      return { ...base, status: "Offline", action: { id: "retry", label: "Try again" } };
    case "starting":
      return { ...base, status: "Starting" };
    case "off":
      return { ...base, status: "Not live" };
  }
}

// --- links ----------------------------------------------------------------------

/** Where Steam installs a game the owner does not have. */
export const installUrl = (appid: number) => `steam://install/${appid}`;

/** Steam's own window, where the owner signs in to their account. */
export const OPEN_STEAM_URL = "steam://open/main";

/** The owner's Steam library, where every game they own can be installed. */
export const STEAM_LIBRARY_URL = "steam://open/games";
