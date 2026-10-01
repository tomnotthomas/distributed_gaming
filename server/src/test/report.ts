// A host report from a PC that can play every game the tests book: the
// payload docs/system-design/host.md describes, valid as it stands.

import type { HostReport } from "../profile.js";

/** Counter-Strike 2 and Dota 2, the games the tests book. */
export const GAMES = [730, 570];

/** A capable PC with both test games installed. */
export const REPORT = {
  name: "Nova-01",
  hardware: {
    gpu: "NVIDIA GeForce RTX 4070",
    vramMb: 12_288,
    ramMb: 32_768,
    cpu: "AMD Ryzen 7 7800X3D",
    cores: 8,
    encoders: ["h264", "hevc", "av1"],
    display: { width: 2560, height: 1440, refreshHz: 144 },
  },
  games: GAMES,
  controls: ["kb", "mouse", "pad"],
  net: { rttMs: 12, jitterMs: 2.5, upMbps: 48 },
} satisfies HostReport;
