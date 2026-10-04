// Demo data: Nova-01, the design's example PC, with the demand, standing,
// rate and earnings the platform does not report yet. It appears only when the
// app is opened with --demo (?demo=1), always under a "Demo data" label, and is
// never mixed with this PC's own data.

import type { DemandRow, Earnings, Game, Hardware, Live, Standing, Step, SteamSetup } from "./model";
import { MINUTE } from "./format";
import { localArt, type ArtSource } from "./ui/art";
import art730 from "./demo-art/730.jpg";
import art553850 from "./demo-art/553850.jpg";
import art1086940 from "./demo-art/1086940.jpg";
import art1091500 from "./demo-art/1091500.jpg";
import art1245620 from "./demo-art/1245620.jpg";
import art1551360 from "./demo-art/1551360.jpg";
import art1716740 from "./demo-art/1716740.jpg";
import art2073850 from "./demo-art/2073850.jpg";

/** The demo flag: `?demo=1` on the renderer's address, which main sets for --demo. */
export const isDemo = (search: string): boolean => new URLSearchParams(search).get("demo") === "1";

export const DEMO_MACHINE = "Nova-01";

export const DEMO_HARDWARE: Hardware = {
  gpu: "NVIDIA GeForce RTX 4080",
  vramMb: 16_384,
  ramMb: 32_768,
  cpu: "Ryzen 7 7800X3D",
  cores: 8,
  encoders: ["h264", "hevc", "av1"],
  display: null,
  upMbps: 500,
};

export const DEMO_HARDWARE_RATE = 1;

export const DEMO_INSTALLED: Game[] = [
  { appid: 730, name: "Counter-Strike 2" },
  { appid: 1245620, name: "Elden Ring" },
  { appid: 2073850, name: "THE FINALS" },
  { appid: 1091500, name: "Cyberpunk 2077" },
  { appid: 1551360, name: "Forza Horizon 5" },
  { appid: 1716740, name: "Starfield" },
];

export const DEMO_OFFERED = [730, 1245620, 2073850, 1091500];

export const DEMO_DEMAND: DemandRow[] = [
  { appid: 730, name: "Counter-Strike 2", looking: 38 },
  { appid: 1245620, name: "Elden Ring", looking: 31 },
  { appid: 1086940, name: "Baldur's Gate 3", looking: 27 },
  { appid: 553850, name: "Helldivers 2", looking: 22 },
  { appid: 2073850, name: "THE FINALS", looking: 17 },
  { appid: 1091500, name: "Cyberpunk 2077", looking: 12 },
  { appid: 1551360, name: "Forza Horizon 5", looking: 6 },
  { appid: 1716740, name: "Starfield", looking: 3 },
];

/** Steam on Nova-01: signed in, with Baldur's Gate 3 downloading. */
export const DEMO_STEAM: SteamSetup = {
  status: { installed: true, running: true, signedIn: true },
  installer: { kind: "idle" },
  installs: [
    {
      appid: 1086940,
      name: "Baldur's Gate 3",
      phase: "downloading",
      done: 63_000_000_000,
      total: 150_000_000_000,
    },
  ],
  asked: [],
};

/** The demo games' key art, bundled with the app (from prototypes/assets). */
const DEMO_ART: Record<number, string> = {
  730: art730,
  553850: art553850,
  1086940: art1086940,
  1091500: art1091500,
  1245620: art1245620,
  1551360: art1551360,
  1716740: art1716740,
  2073850: art2073850,
};

/** Bundled art for the demo's games; anything else as this PC's Steam keeps it. */
export const demoArt: ArtSource = (appid) => (DEMO_ART[appid] ? [DEMO_ART[appid]] : localArt(appid));

/** Players looking for a PC near Nova-01 right now. */
export const DEMO_NEAR = 14;

export const DEMO_STANDING: Standing = {
  reliability: 96,
  was: null,
  reliableHours: 61,
  finished: { done: 12, of: 12 },
};

/** What ending a session early costs in the demo: 96 → 91. */
export const DEMO_EARLY_END_RELIABILITY = 91;

export const DEMO_EARNINGS: Earnings = {
  earned: 0.42,
  firstPayoutAt: 5,
  nextPayout: "1 Oct",
  accountEnding: "31",
  month: { name: "September", amount: 12.4, sessions: 18, hours: 31 },
  payouts: [
    { month: "August", sessions: 61, hours: 132, amount: 65 },
    { month: "July", sessions: 48, hours: 104, amount: 51 },
    { month: "June", sessions: 17, hours: 39, amount: 19 },
  ],
  today: 0.42,
};

/** The design's screens, in its order. */
export const DEMO_SCREENS = [
  { id: "pc", name: "Read this PC" },
  { id: "steam", name: "Set up Steam" },
  { id: "games", name: "Choose your games" },
  { id: "golive", name: "Go live" },
  { id: "waiting", name: "Live, waiting" },
  { id: "streaming", name: "Live, streaming" },
  { id: "inuse", name: "In use when you sit down" },
  { id: "ending", name: "Ending early" },
  { id: "paused", name: "Paused" },
  { id: "offline", name: "Offline" },
  { id: "payout", name: "Get paid, add details" },
  { id: "paid", name: "Get paid, set up" },
  { id: "settings", name: "Settings, connection" },
  { id: "tray", name: "Tray glance" },
] as const;

export type DemoScreen = (typeof DEMO_SCREENS)[number]["id"];

export const isDemoScreen = (id: string | null): id is DemoScreen => DEMO_SCREENS.some((s) => s.id === id);

/** One evening, on this PC's clock: 21:00 is when Nova-01 went live. */
export const evening = (hh: number, mm = 0): number => {
  const d = new Date(2026, 8, 24, 21, 0, 0, 0);
  d.setHours(hh, mm);
  if (hh < 12) d.setDate(d.getDate() + 1);
  return d.getTime();
};

const LIVE_FROM = evening(21);
const LIVE_UNTIL = evening(1);
/** Elden Ring, claimed for 90 minutes from 21:10: protected until 22:40. */
const CLAIM = { appid: 1245620, name: "Elden Ring", minutes: 90, at: evening(21, 10), rate: 1.05 };

export type DemoState = {
  step: Step;
  live: Live;
  /** The demo clock at mount, and when that was, so time passes as it does. */
  clockAt: number;
  standing: Standing;
  payoutSaved: boolean;
  setupDone: boolean;
};

/** Where each screen opens: its step, its live state and the time on the clock. */
export function demoState(screen: DemoScreen): DemoState {
  const session = (atPc: boolean) =>
    ({
      kind: "session",
      since: LIVE_FROM,
      until: LIVE_UNTIL,
      claim: CLAIM,
      playerHere: true,
      stopNew: false,
      notify: false,
      atPc,
    }) as const;
  const base = { standing: DEMO_STANDING, payoutSaved: false, setupDone: true };
  const off: Live = { kind: "off", note: null };
  switch (screen) {
    case "pc":
      return { ...base, setupDone: false, step: "pc", live: off, clockAt: evening(20, 52) };
    case "steam":
      return { ...base, setupDone: false, step: "steam", live: off, clockAt: evening(20, 53) };
    case "games":
      return { ...base, setupDone: false, step: "games", live: off, clockAt: evening(20, 55) };
    case "golive":
      return { ...base, step: "live", live: off, clockAt: evening(21) };
    case "waiting":
      return {
        ...base,
        step: "live",
        live: { kind: "waiting", since: LIVE_FROM, until: LIVE_UNTIL, registered: true },
        clockAt: evening(21),
      };
    case "streaming":
      return { ...base, step: "live", live: session(false), clockAt: CLAIM.at + 23 * MINUTE };
    case "inuse":
      return { ...base, step: "live", live: session(true), clockAt: evening(22, 3) };
    case "ending":
      return {
        ...base,
        standing: {
          ...DEMO_STANDING,
          reliability: DEMO_EARLY_END_RELIABILITY,
          was: DEMO_STANDING.reliability,
        },
        step: "live",
        live: { kind: "ending", until: LIVE_UNTIL, claim: CLAIM, warnedAt: evening(22, 3) },
        clockAt: evening(22, 3),
      };
    case "paused":
      return {
        ...base,
        step: "live",
        live: { kind: "paused", at: evening(21, 31) },
        clockAt: evening(21, 31),
      };
    case "offline":
      return {
        ...base,
        step: "live",
        live: { kind: "offline", since: evening(21, 42), lastContact: evening(21, 42), until: LIVE_UNTIL },
        clockAt: evening(21, 42),
      };
    case "payout":
      return { ...base, step: "paid", live: off, clockAt: evening(21) };
    case "paid":
      return { ...base, payoutSaved: true, step: "paid", live: off, clockAt: evening(21) };
    case "settings":
      return { ...base, step: "settings", live: off, clockAt: evening(21) };
    case "tray":
      return { ...base, step: "live", live: session(false), clockAt: evening(21, 58) };
  }
}
