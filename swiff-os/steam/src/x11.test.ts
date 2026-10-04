import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFocusedApp, parseWindows, steamWindows, x11Display, type Run } from "./x11.ts";

// `xwininfo -root -tree` in the test VM with Steam at its sign-in window, trimmed,
// plus one big Steam window of our own.
const TREE = `
xwininfo: Window id: 0x21f (the root window) (has no name)

  Root window id: 0x21f (the root window) (has no name)
  Parent window id: 0x0 (none)
     5 children:
     0x1a00016 "Sign in to Steam": ("steamwebhelper" "steam")  700x440+290+180  +290+180
        1 child:
        0x1600006 (has no name): ()  700x440+0+0  +290+180
     0x1800004 "steamwebhelper": ("steamwebhelper" "Steamwebhelper")  200x200+0+0  +0+0
     0x1600001 "Chromium clipboard": ()  10x10+-100+-100  +-100+-100
     0xe00001 "steam": ("steam" "Steam")  10x10+10+10  +10+10
     0x2000005 "Steam \\"Big\\" window": ("steamwebhelper" "steam")  1280x800+0+0  +0+0
`;

describe("parseWindows", () => {
  it("reads every window at any depth, with its name, classes and size", () => {
    expect(parseWindows(TREE)).toEqual([
      {
        id: "0x1a00016",
        name: "Sign in to Steam",
        classes: ["steamwebhelper", "steam"],
        width: 700,
        height: 440,
      },
      { id: "0x1600006", name: "", classes: [], width: 700, height: 440 },
      {
        id: "0x1800004",
        name: "steamwebhelper",
        classes: ["steamwebhelper", "Steamwebhelper"],
        width: 200,
        height: 200,
      },
      { id: "0x1600001", name: "Chromium clipboard", classes: [], width: 10, height: 10 },
      { id: "0xe00001", name: "steam", classes: ["steam", "Steam"], width: 10, height: 10 },
      {
        id: "0x2000005",
        name: 'Steam \\"Big\\" window',
        classes: ["steamwebhelper", "steam"],
        width: 1280,
        height: 800,
      },
    ]);
  });
});

describe("steamWindows", () => {
  it("keeps Steam's windows big enough for a QR code, largest first", () => {
    expect(steamWindows(parseWindows(TREE)).map((w) => w.id)).toEqual([
      "0x2000005",
      "0x1a00016",
      "0x1800004",
    ]);
  });
});

describe("parseFocusedApp", () => {
  it("reads the app id gamescope has on screen", () => {
    expect(parseFocusedApp("GAMESCOPE_FOCUSED_APP = 570\n")).toBe(570);
    expect(parseFocusedApp("GAMESCOPE_FOCUSED_APP = 0\n")).toBe(0);
  });

  it("is null before gamescope sets it", () => {
    expect(parseFocusedApp("GAMESCOPE_FOCUSED_APP:  not found.\n")).toBeNull();
  });
});

describe("x11Display", () => {
  it("decodes the QR codes on Steam's windows only, and deletes each screen grab", async () => {
    const calls: string[][] = [];
    const grabs: string[] = [];
    const runner: Run = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "xwininfo") return { code: 0, stdout: TREE };
      if (file === "xwd") {
        grabs.push(args.at(-1)!);
        return { code: args[2] === "0x2000005" ? 1 : 0, stdout: "" };
      }
      if (file === "zbarimg")
        return args.at(-1) === grabs[1]
          ? { code: 0, stdout: "https://s.team/q/1/42\n" }
          : { code: 4, stdout: "" };
      return { code: 1, stdout: "" };
    };

    expect(await x11Display(runner).qrCodes()).toEqual(["https://s.team/q/1/42"]);
    // The big window failed to grab, so only the other two were read.
    expect(calls.filter(([file]) => file === "xwd").map((c) => c[3])).toEqual([
      "0x2000005",
      "0x1a00016",
      "0x1800004",
    ]);
    expect(calls.filter(([file]) => file === "zbarimg")).toHaveLength(2);
    expect(grabs.every((grab) => !existsSync(grab))).toBe(true);
  });

  it("finds no QR code when zbar finds none", async () => {
    const runner: Run = async (file) =>
      file === "xwininfo" ? { code: 0, stdout: TREE } : { code: file === "zbarimg" ? 4 : 0, stdout: "" };
    expect(await x11Display(runner).qrCodes()).toEqual([]);
  });

  it("asks gamescope's root window for the focused app", async () => {
    const runner: Run = async () => ({ code: 0, stdout: "GAMESCOPE_FOCUSED_APP = 570\n" });
    expect(await x11Display(runner).focusedApp()).toBe(570);
  });
});
