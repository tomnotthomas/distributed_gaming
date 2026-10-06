// What the agent reads off the gamescope session's X display (Xwayland), with
// the stock X11 tools and zbar, so nothing here talks to Steam itself:
//
//   xwininfo -root -tree                  every window, to find Steam's sign-in window
//   xwd -id <window> | zbarimg            the QR code Steam's sign-in window shows
//   xprop -root GAMESCOPE_FOCUSED_APP     the Steam app id gamescope has on screen
//
// The QR code is Steam's own: the agent only reads it off the screen, the way
// a camera would, so Steam does the whole sign-in itself and no password,
// code or token ever passes through Swiff.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a program; resolves with its exit code and stdout, never rejects on a non-zero exit. */
export type Run = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** Runs with a 10 s timeout; a program that cannot start counts as exit code 1. */
export const run: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout });
    });
  });

export type Window = { id: string; name: string; classes: string[]; width: number; height: number };

// `     0x1e00003 "Sign in to Steam": ("steamwebhelper" "steam")  705x440+0+0  +607+320`
const WINDOW_LINE =
  /^\s*(0x[0-9a-f]+) (?:"((?:[^"\\]|\\.)*)"|\(has no name\)): \(((?:"[^"]*" ?)*)\)\s+(\d+)x(\d+)/;

/** Every window in `xwininfo -root -tree` output, at any depth. */
export function parseWindows(tree: string): Window[] {
  const windows: Window[] = [];
  for (const line of tree.split("\n")) {
    const m = WINDOW_LINE.exec(line);
    if (!m) continue;
    windows.push({
      id: m[1]!,
      name: m[2] ?? "",
      classes: [...m[3]!.matchAll(/"([^"]*)"/g)].map((c) => c[1]!),
      width: Number(m[4]),
      height: Number(m[5]),
    });
  }
  return windows;
}

/** Smaller than this cannot hold a QR code zbar can read. */
const MIN_SIDE = 200;

/** Steam's own windows big enough to show its sign-in QR code, largest first. */
export function steamWindows(windows: Window[]): Window[] {
  return windows
    .filter((w) => w.classes.some((c) => /^steam/i.test(c)) && w.width >= MIN_SIDE && w.height >= MIN_SIDE)
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/** The app id in `xprop -root -notype GAMESCOPE_FOCUSED_APP` output, or null when gamescope has not set one. */
export function parseFocusedApp(xprop: string): number | null {
  const m = /GAMESCOPE_FOCUSED_APP = (\d+)/.exec(xprop);
  return m ? Number(m[1]) : null;
}

export type Display = {
  /** The text of every QR code on Steam's windows, as zbar decodes it. */
  qrCodes(): Promise<string[]>;
  /** The Steam app id gamescope shows, 0 for a window that is not a game, null before gamescope sets it. */
  focusedApp(): Promise<number | null>;
};

/**
 * The X display this process was started on (DISPLAY, which gamescope sets for
 * the programs it runs). Screen grabs go to a private temporary directory, are
 * read once and deleted at once: they can hold a live sign-in code.
 */
export function x11Display(runner: Run = run): Display {
  return {
    /** Every code decoded from Steam's windows now on screen. */
    async qrCodes() {
      const tree = await runner("xwininfo", ["-root", "-tree"]);
      if (tree.code !== 0) return [];
      const codes: string[] = [];
      for (const window of steamWindows(parseWindows(tree.stdout))) {
        const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "swiff-qr-"));
        try {
          const grab = join(dir, "window.xwd");
          // An unmapped window, or one that closed in between, fails here: not a QR code.
          if ((await runner("xwd", ["-silent", "-id", window.id, "-out", grab])).code !== 0) continue;
          const read = await runner("zbarimg", ["--raw", "--quiet", "-Sdisable", "-Sqrcode.enable", grab]);
          if (read.code === 0) codes.push(...read.stdout.split("\n").filter(Boolean));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      return codes;
    },
    /** The app gamescope has in front, or null when that cannot be read. */
    async focusedApp() {
      const prop = await runner("xprop", ["-root", "-notype", "GAMESCOPE_FOCUSED_APP"]);
      return prop.code === 0 ? parseFocusedApp(prop.stdout) : null;
    },
  };
}
