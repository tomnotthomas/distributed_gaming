import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveLogin } from "./serve.ts";
import type { SteamClient } from "./steam.ts";
import type { Display } from "./x11.ts";

const QR = "https://s.team/q/1/1111111111111111111";

let dir: string;
let server: Server | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "swiff-steam-login-"));
});
afterEach(async () => {
  server?.close();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

/** Send one command and read every line back until the agent closes. */
function ask(path: string, command: string, onLine?: (line: unknown) => void): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path, () => conn.write(`${command}\n`));
    const lines: unknown[] = [];
    let text = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      text += chunk;
      let end;
      while ((end = text.indexOf("\n")) !== -1) {
        const line = JSON.parse(text.slice(0, end));
        text = text.slice(end + 1);
        lines.push(line);
        onLine?.(line);
      }
    });
    conn.on("error", reject);
    conn.on("end", () => resolve(lines));
  });
}

/** A Steam the test signs in by hand, on a screen that shows QR until then. */
function steamAt() {
  let signedIn = false;
  let focused = 0;
  const steam: SteamClient = {
    signedIn: async () => signedIn,
    launch: async (appid) => {
      focused = appid;
    },
  };
  const display: Display = {
    qrCodes: async () => (signedIn ? [] : [QR]),
    focusedApp: async () => focused,
  };
  return { steam, display, signIn: () => (signedIn = true) };
}

const fast = { sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)) };

describe("serveLogin", () => {
  it("streams a play's events, one per line, and closes after the last", async () => {
    const path = join(dir, "login.sock");
    const at = steamAt();
    server = await serveLogin(path, { ...at, ...fast });

    const lines = await ask(path, "play 570", (line) => {
      if ((line as { event: string }).event === "qr") at.signIn();
    });

    expect(lines.map((l) => (l as { event: string }).event)).toEqual([
      "qr",
      "signed-in",
      "launching",
      "game-on-screen",
    ]);
    expect(lines[0]).toMatchObject({ url: QR });
  });

  it("is for its user and group only", async () => {
    const path = join(dir, "login.sock");
    server = await serveLogin(path, { ...steamAt(), ...fast });

    expect((await stat(path)).mode & 0o777).toBe(0o660);
  });

  it("says whether Steam is ready for a renter", async () => {
    const path = join(dir, "login.sock");
    const at = steamAt();
    server = await serveLogin(path, { ...at, ...fast });

    expect(await ask(path, "status")).toEqual([{ steam: "sign-in" }]);
    at.signIn();
    expect(await ask(path, "status")).toEqual([{ steam: "signed-in" }]);
  });

  it("runs one play at a time, and hanging up stops it", async () => {
    const path = join(dir, "login.sock");
    server = await serveLogin(path, { ...steamAt(), ...fast });

    const first = createConnection(path, () => first.write("play 570\n"));
    await new Promise((resolve) => first.once("data", resolve));
    expect(await ask(path, "play 570")).toEqual([{ event: "failed", reason: "busy", atMs: 0 }]);

    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = createConnection(path, () => again.write("play 570\n"));
    const line = await new Promise<string>((resolve) =>
      again.once("data", (chunk) => resolve(String(chunk))),
    );
    again.destroy();
    expect(JSON.parse(line)).toMatchObject({ event: "qr" });
  }, 1_000);

  it("refuses anything but status and play with an app id", async () => {
    const path = join(dir, "login.sock");
    server = await serveLogin(path, { ...steamAt(), ...fast });

    for (const command of ["play", "play abc", "play 0", "play 570; reboot", "launch 570"])
      expect(await ask(path, command)).toEqual([{ error: "unknown-command" }]);
  });
});
