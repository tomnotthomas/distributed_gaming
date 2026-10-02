// What a PC owner could earn by sharing, before they install anything. The
// server has no estimate of its own: the desktop app reads the hardware and
// sets the exact rate, so the website works from the tier the owner picks and
// the week they describe. The same model runs in the renter prototype's Share
// your PC frames (prototypes/Swiff v7.dc.html).

export type TierId = "entry" | "solid" | "high" | "enthusiast";

export type Tier = {
  id: TierId;
  name: string;
  /** Euros an hour streamed. Hosts keep all of it. */
  rate: number;
  /** What a rig of this tier draws while streaming. */
  watts: number;
  /** An example rig, part by part: what each adds to the rate. */
  parts: { part: string; rate: number }[];
};

export const TIERS: Tier[] = [
  {
    id: "entry",
    name: "Entry",
    rate: 0.45,
    watts: 250,
    parts: [
      { part: "GPU, GTX 1660 Super", rate: 0.25 },
      { part: "CPU, Ryzen 5 3600", rate: 0.1 },
      { part: "Memory, 16 GB", rate: 0.05 },
      { part: "Connection, 100 Mbit", rate: 0.05 },
    ],
  },
  {
    id: "solid",
    name: "Solid",
    rate: 0.65,
    watts: 320,
    parts: [
      { part: "GPU, RTX 3060 Ti", rate: 0.35 },
      { part: "CPU, Ryzen 5 5600X", rate: 0.15 },
      { part: "Memory, 16 GB", rate: 0.05 },
      { part: "Connection, 250 Mbit", rate: 0.1 },
    ],
  },
  {
    id: "high",
    name: "High-end",
    rate: 1,
    watts: 420,
    parts: [
      { part: "GPU, RTX 4080", rate: 0.6 },
      { part: "CPU, Ryzen 7 7800X3D", rate: 0.2 },
      { part: "Memory, 32 GB", rate: 0.1 },
      { part: "Connection, 500 Mbit", rate: 0.1 },
    ],
  },
  {
    id: "enthusiast",
    name: "Enthusiast",
    rate: 1.3,
    watts: 550,
    parts: [
      { part: "GPU, RTX 4090", rate: 0.8 },
      { part: "CPU, Ryzen 9 7950X3D", rate: 0.25 },
      { part: "Memory, 64 GB", rate: 0.1 },
      { part: "Connection, 1 Gbit", rate: 0.15 },
    ],
  },
];

export const tier = (id: TierId): Tier => TIERS.find((t) => t.id === id)!;

/** The share of time away that players book: a typical month, a quiet one and a busy one. */
export const BOOKED = 0.55;
export const QUIET = 0.35;
export const BUSY = 0.75;
export const WEEKS_PER_MONTH = 4.33;
/** Sharing starts in the evening; the away window runs from here for the hours away. */
export const AWAY_FROM = 20;

export type Week = {
  tier: TierId;
  /** Hours away from the PC on a day it is shared. */
  hoursPerDay: number;
  daysPerWeek: number;
  /** Euros per kWh. */
  electricity: number;
};

export const DEFAULT_WEEK: Week = { tier: "high", hoursPerDay: 6, daysPerWeek: 5, electricity: 0.3 };

/** What each slider on the sheet can be set to. */
export const LIMITS = {
  hoursPerDay: { min: 1, max: 16, step: 1 },
  daysPerWeek: { min: 1, max: 7, step: 1 },
  electricity: { min: 0.1, max: 0.6, step: 0.01 },
} as const;

export type Estimate = {
  /** Hours away a week. */
  weekHours: number;
  /** Hours a month players are likely to stream, rounded as the sheet prints them. */
  streamedHours: number;
  /** Whole euros earned at the tier's rate. */
  gross: number;
  /** Whole euros of electricity those hours cost. */
  power: number;
  /** Whole euros a month after electricity: exactly gross less power, so the sheet adds up. */
  net: number;
  /** A quiet month and a busy one, after electricity. */
  low: number;
  high: number;
};

function month(week: Week, booked: number) {
  const t = tier(week.tier);
  const hours = week.hoursPerDay * week.daysPerWeek * booked * WEEKS_PER_MONTH;
  return { hours, gross: hours * t.rate, power: ((hours * t.watts) / 1000) * week.electricity };
}

/** A month's earnings for a week away, after electricity. */
export function estimate(week: Week): Estimate {
  const typical = month(week, BOOKED);
  const quiet = month(week, QUIET);
  const busy = month(week, BUSY);
  const gross = Math.round(typical.gross);
  const power = Math.round(typical.power);
  return {
    weekHours: week.hoursPerDay * week.daysPerWeek,
    streamedHours: Math.round(typical.hours),
    gross,
    power,
    net: Math.max(0, gross - power),
    low: Math.max(0, Math.round(quiet.gross - quiet.power)),
    high: Math.max(0, Math.round(busy.gross - busy.power)),
  };
}

/** Euros the European way, without the sign: 0.45 → "0,45". */
export const euros = (n: number, decimals = 2): string => n.toFixed(decimals).replace(".", ",");

const clock = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/** The evening the PC is shared: "20:00 to 02:00" for six hours away. */
export function awayWindow(hoursPerDay: number): string {
  return `${clock(AWAY_FROM)} to ${clock(AWAY_FROM + hoursPerDay)}`;
}

/** "a High-end rig", "an Entry rig". */
export const withArticle = (name: string): string => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
