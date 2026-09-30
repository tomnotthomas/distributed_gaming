// What rank() reads. Every field is a plain value so the web page and the
// server matchmaker can fill it from wherever they get it: seed data today,
// heartbeats, probes and the requirements table later.

/** A way the renter plays. `pad` needs a virtual gamepad driver on the host. */
export type Control = "kb" | "mouse" | "pad";

/** Video encoders the host's GPU offers for the stream. */
export type Encoder = "h264" | "hevc" | "av1";

/** The renter's Picture setting: Best available, 4K first, or 120 fps first. */
export type PicturePref = "best" | "4k" | "120fps";

/** Seven days of behaviour, bucketed. `new` ranks as `ok` but is labelled. */
export type Stability = "steady" | "ok" | "shaky" | "new";

/** The hard gates. A host that fails any of them is never listed. */
export type GateId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6";

/** The sort rules, in the order they are tried. */
export type RuleId = "O1" | "O2" | "O3" | "O4" | "O5" | "O6";

/** A gaming PC as its host app reports it. */
export type HostProfile = {
  id: string;
  /** The owner's account id, compared with the renter's for E5. */
  ownerId: string;
  status: "available" | "busy" | "offline";
  /** Last heartbeat, epoch ms. */
  lastHeartbeatAt: number;
  /** Steam appids installed and ready to launch. */
  installed: number[];
  /** GPU name as reported, looked up in the GPU score table. */
  gpu: string;
  ramGb: number;
  vramGb: number;
  controls: Control[];
  encoders: Encoder[];
  uploadMbps: number;
  /** Whether it can stream at 120 fps. */
  fps120: boolean;
  priceCentsPerHour: number;
  /** When the owner wants it back, epoch ms. */
  availableUntil: number;
};

/** What a game asks of a host, as GPU scores (RTX 3060 = 100) and gigabytes. */
export type GameRequirements = {
  appid: number;
  minGpuScore: number;
  recGpuScore: number;
  minRamGb: number;
  minVramGb: number;
};

/** The network path from this renter to one host. */
export type LinkStats = {
  rttMs: number;
  jitterP95Ms: number;
  /** Through a TURN relay rather than direct. */
  relayed: boolean;
};

/** Seven days of a host's history, as the server observes it. */
export type StabilityStats = {
  /** Share of offered time with heartbeats, 0-1. */
  heartbeatCoverage: number;
  /** Offline drops per offered hour. */
  dropsPerHour: number;
  /** Share of sessions not ended by the host going away, 0-1. */
  sessionCompletion: number;
  /** Median packet loss from renter QoS, 0-1. */
  packetLoss: number;
  sessions: number;
  offeredHours: number;
};

/** One host as seen by one renter: its profile, the path to it, its history. */
export type Candidate = {
  host: HostProfile;
  /** Null when the host has not been reached from this renter. */
  link: LinkStats | null;
  history: StabilityStats;
};

/** Who is asking and what they asked for. */
export type RenterPrefs = {
  /** The renter's account id, compared with each owner's for E5. */
  id: string;
  /** Controls the renter has turned on; a host must support all of them. */
  controls: Control[];
  picture: PicturePref;
  /** Tonight's length in minutes. */
  sessionMinutes: number;
};

/** Knobs and the clock. `now` is an argument so rank() stays pure. */
export type RankOptions = {
  now: number;
  /** E6: the slowest round trip still offered. Default 80 ms. */
  maxRttMs?: number;
  /** E1: the oldest heartbeat still counted as live. Default 15 s. */
  heartbeatMaxAgeMs?: number;
};

/** A host that passed every gate, with the scores the sort used. */
export type RankedHost = Candidate & {
  /** Always known: E6 lists no host without one. */
  link: LinkStats;
  response: number;
  picture: number;
  stability: Stability;
  /** Host GPU score over the game's recommended score. */
  headroom: number;
  minutesLeft: number;
  coversSession: boolean;
};

/** A host that is not listed, and every gate it failed. */
export type Excluded = { candidate: Candidate; failed: GateId[] };

/** Why the first host beat the second: the rule that decided, in words. */
export type Reason = { rule: RuleId; label: string };

export type RankResult = {
  /** Eligible hosts, best first. */
  hosts: RankedHost[];
  /** Hosts that fail only because they are busy right now: "back at". */
  later: Candidate[];
  excluded: Excluded[];
  /** Null with fewer than two hosts: nothing was decided. */
  reason: Reason | null;
};
