// The wall's nine hand-authored titles, and the five invented machines the
// demo (/?demo=1, and the tests) runs them on. Everywhere else the machines
// are the real hosts on offer, as the server ranks them (live.ts).
//
// Art and trailers come straight from Steam's CDN, keyed by appid: publisher-
// owned promotional media, which is what a real client would be showing. A
// player's own library is merged on top of this at sign-in (see steam.ts).

import type { Control, Encoder, StabilityStats } from "@swiff/rank";

export type Game = {
  id: string;
  title: string;
  /** Title split across two lines on the game screen. */
  t1: string;
  t2: string;
  appid: number;
  /** object-position for the hero, so the art's subject survives the crop. */
  focus: string;
  promise: string;
  personal: string;
  hue: number;
  hours: number;
  owned: boolean;
  save: string;
  /** The demo machines that have it installed. Real hosts say for themselves. */
  machines: string[];
  f2p?: boolean;
  last?: string;
  /** Steam store trailer id, for the hand-authored nine. */
  video?: number;
  /** Media from the server's catalog, at the exact URLs Steam gives. Wins over the guessable ones. */
  media?: GameMedia;
  /** Generated from the player's real library rather than hand-authored. */
  fromLibrary?: boolean;
  /** Hardware the game asks for. Without it, a GTX 1060 minimum and an RTX 3060 recommended card. */
  requirements?: Requirements;
};

/** A game's system requirements, as GPU names from the score table and gigabytes. */
export type Requirements = { minGpu: string; recGpu: string; minRamGb: number; minVramGb: number };

/** A game's media at the exact URLs Steam's catalog gives (server/src/catalog.ts). */
export type GameMedia = {
  /** Wide key art at 2x (3840 wide). */
  hero: string | null;
  /** The store capsule, else header, for games without key art. */
  capsule: string | null;
  /** An ~8 s .mp4 clip for hover previews. */
  preview: string | null;
  /** The full highlight trailer as HLS. */
  trailer: string | null;
};

/** A machine as the wall and the game page show it: a demo machine, or a real host. */
export type Machine = {
  id: string;
  name: string;
  /** Who shares it. Only the demo says; the server never tells a renter who owns a machine. */
  owner?: string;
  gpu: string;
  cpu?: string;
  ping: number;
  /** "1440p 120" — the ceiling this machine can actually deliver. */
  quality: string;
  /** Clock time the owner has promised it until, or "late". */
  until: string;
  /** A real host's free-until as Unix ms, when it is not "late"; demo machines go by `until` alone. */
  untilAt?: number;
  busy: boolean;
  /** Clock time a busy machine is free again. */
  back?: string;
  /** Your own PC. Never listed, recommended or matched (gate E5). */
  self?: boolean;
  /** Picture and Response 1-4 as the server's rank() scored them for this game; demo machines are scored here. */
  scores?: { picture: number; response: number };
};

/** A demo machine: everything the host app would report, so rank() can run on it in the page. */
export type SeedMachine = Machine & {
  owner: string;
  cpu: string;
  /** "Ultra · 1440p 120". */
  tier: string;
  ramGb: number;
  vramGb: number;
  controls: Control[];
  encoders: Encoder[];
  uploadMbps: number;
  priceCentsPerHour: number;
  /** The last seven days, as the server observes them. */
  history: StabilityStats;
};

/** What the wall knows about one game's machines right now. */
export type Spot = {
  /** Machines free right now, for however long. */
  free: number;
  /** Of those, the ones free for the whole session you asked for: "Ready". */
  ready: number;
  /** Machines that would fit but are taken. */
  busy: number;
  /** The best of those, the one the wall offers; null when none is. */
  best: Machine | null;
  /** When none is: a busy machine that comes back, the clock time it does, and that time as ms to compare by. */
  back: { name: string; at: string; backAt: number } | null;
};

export type SessionLength = "quick" | "evening" | "night";

export const GAMES: Game[] = [
  {
    id: "er",
    title: "Elden Ring",
    t1: "Elden",
    t2: "Ring",
    appid: 1245620,
    focus: "70% 50%",
    promise: "Return to the Lands Between.",
    personal: "Liurnia · yesterday",
    hue: 30,
    hours: 61,
    owned: true,
    save: "Cloud save · Liurnia",
    machines: ["nova", "glass", "tide", "ember"],
    last: "yesterday",
    video: 256839312,
    // The plan's worked example measures headroom against an RTX 3060.
    requirements: { minGpu: "GTX 1060", recGpu: "RTX 3060", minRamGb: 12, minVramGb: 3 },
  },
  {
    id: "val",
    title: "THE FINALS",
    t1: "THE",
    t2: "FINALS",
    appid: 2073850,
    focus: "60% 50%",
    promise: "Last team standing takes it.",
    personal: "Yesterday · cashed out twice",
    hue: 355,
    hours: 140,
    owned: true,
    save: "Steam cloud save",
    machines: ["glass", "ember"],
    f2p: true,
    last: "yesterday",
    video: 257102318,
  },
  {
    id: "cp",
    title: "Cyberpunk 2077",
    t1: "Cyberpunk",
    t2: "2077",
    appid: 1091500,
    focus: "65% 40%",
    promise: "Night City is awake.",
    personal: "Act 2 · 3 days ago",
    hue: 210,
    hours: 22,
    owned: true,
    save: "Cloud save · Act 2",
    machines: ["glass", "tide"],
    last: "3 days ago",
    video: 256977924,
  },
  {
    id: "bg3",
    title: "Baldur's Gate 3",
    t1: "Baldur's",
    t2: "Gate 3",
    appid: 1086940,
    focus: "70% 50%",
    promise: "Your party is waiting.",
    personal: "New game",
    hue: 95,
    hours: 9,
    owned: false,
    save: "New game",
    machines: ["tide", "moss"],
    video: 256961600,
  },
  {
    id: "hd2",
    title: "Helldivers 2",
    t1: "Helldivers 2",
    t2: "",
    appid: 553850,
    focus: "60% 50%",
    promise: "Dive. Together.",
    personal: "New game",
    hue: 215,
    hours: 0,
    owned: false,
    save: "New game",
    machines: ["ember", "moss"],
    video: 256957675,
  },
  {
    id: "ff",
    title: "Forza Horizon 5",
    t1: "Forza",
    t2: "Horizon 5",
    appid: 1551360,
    focus: "70% 60%",
    promise: "Mexico, at full speed.",
    personal: "Tuesday · 41 min",
    hue: 45,
    hours: 4,
    owned: false,
    save: "Cloud save",
    machines: ["tide"],
    last: "Tuesday",
    video: 256859757,
  },
  {
    id: "cs",
    title: "Counter-Strike 2",
    t1: "Counter-Strike 2",
    t2: "",
    appid: 730,
    focus: "65% 50%",
    promise: "One more round.",
    personal: "2 days ago · 2 h 05 m",
    hue: 200,
    hours: 300,
    owned: true,
    save: "Steam linked",
    machines: ["nova", "glass", "ember", "moss"],
    f2p: true,
    last: "2 days ago",
    video: 256972298,
  },
  {
    id: "hk",
    title: "Hollow Knight: Silksong",
    t1: "Hollow Knight",
    t2: "Silksong",
    appid: 1030300,
    focus: "70% 50%",
    promise: "Ascend to the peak.",
    personal: "New game",
    hue: 195,
    hours: 0,
    owned: false,
    save: "New game",
    machines: ["moss"],
    video: 257186996,
  },
  {
    id: "sf",
    title: "Starfield",
    t1: "Starfield",
    t2: "",
    appid: 1716740,
    focus: "60% 40%",
    promise: "The stars are yours.",
    personal: "New game",
    hue: 25,
    hours: 0,
    owned: false,
    save: "New game",
    machines: ["glass"],
    video: 256952210,
  },
];

// Seven days of history, three ways: a host with a clean record, an ordinary
// one, and one too new to judge.
const STEADY: StabilityStats = {
  heartbeatCoverage: 0.998,
  dropsPerHour: 0.05,
  sessionCompletion: 0.97,
  packetLoss: 0.004,
  sessions: 40,
  offeredHours: 120,
};
const OK: StabilityStats = { ...STEADY, heartbeatCoverage: 0.985, dropsPerHour: 0.2 };
const NEW: StabilityStats = { ...STEADY, sessions: 2, offeredHours: 6 };

export const MACHINES: Record<string, SeedMachine> = {
  nova: {
    id: "nova",
    name: "Nova-01",
    owner: "you",
    gpu: "RTX 4080",
    cpu: "Ryzen 7 7800X3D",
    ping: 2,
    quality: "1440p 120",
    tier: "Ultra · 1440p 120",
    until: "late",
    busy: false,
    self: true,
    ramGb: 32,
    vramGb: 16,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc", "av1"],
    uploadMbps: 30,
    priceCentsPerHour: 0,
    history: STEADY,
  },
  glass: {
    id: "glass",
    name: "Glasshouse",
    owner: "m0th",
    gpu: "RTX 4090",
    cpu: "Core i9-14900K",
    ping: 9,
    quality: "4K 60",
    tier: "Ultra · 4K 60",
    until: "00:30",
    busy: false,
    ramGb: 32,
    vramGb: 24,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc", "av1"],
    uploadMbps: 50,
    priceCentsPerHour: 180,
    history: STEADY,
  },
  ember: {
    id: "ember",
    name: "Ember",
    owner: "sable.exe",
    gpu: "RTX 4070 Ti",
    cpu: "Ryzen 7 7700",
    ping: 14,
    quality: "1080p 120",
    tier: "High · 1080p 120",
    until: "21:10",
    busy: false,
    ramGb: 32,
    vramGb: 12,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc", "av1"],
    uploadMbps: 20,
    priceCentsPerHour: 120,
    history: NEW,
  },
  tide: {
    id: "tide",
    name: "Tide",
    owner: "priya_p",
    gpu: "RX 7900 XTX",
    cpu: "Ryzen 9 7900X",
    ping: 21,
    quality: "1440p 120",
    tier: "Ultra · 1440p 120",
    until: "02:00",
    busy: false,
    ramGb: 32,
    vramGb: 24,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc"],
    uploadMbps: 30,
    priceCentsPerHour: 140,
    history: STEADY,
  },
  moss: {
    id: "moss",
    name: "Moss",
    owner: "theo.b",
    gpu: "RTX 3080",
    cpu: "Ryzen 7 5800X",
    ping: 38,
    quality: "1080p 60",
    tier: "High · 1080p 60",
    until: "23:30",
    busy: true,
    back: "21:30",
    ramGb: 32,
    vramGb: 10,
    controls: ["kb", "mouse", "pad"],
    encoders: ["h264", "hevc"],
    uploadMbps: 18,
    priceCentsPerHour: 90,
    history: OK,
  },
};

const STEAM_ART = "https://cdn.cloudflare.steamstatic.com/steam/apps";

/** The wide, logo-free key art every game ships for its Steam library page, at 1x or 2x (3840 wide). */
export const artUrl = (appid: number, scale: 1 | 2 = 2) =>
  `${STEAM_ART}/${appid}/library_hero${scale === 2 ? "_2x" : ""}.jpg`;

/** The store header. Older games without library art still have one. */
export const headerUrl = (appid: number) => `${STEAM_ART}/${appid}/header.jpg`;

export const trailerUrl = (video: number) =>
  `https://video.akamai.steamstatic.com/store_trailers/${video}/movie480_vp9.webm`;
