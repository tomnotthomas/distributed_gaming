// The agent's local pieces against the real OS: the control socket, the
// streamer process and the resume file.

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReturnReply } from "./agent.ts";
import { sendControl, serveControl } from "./control.ts";
import { fileResumeStore } from "./resume.ts";
import { streamerLauncher } from "./streamer.ts";

const dir = () => mkdtemp(join(tmpdir(), "swiff-hostd-"));

describe("the control socket", () => {
  it("answers status and the owner's request, from root alone", async () => {
    const path = join(await dir(), "control.sock");
    let reply: ReturnReply = { ok: false, reason: "session-live" };
    const server = await serveControl(path, {
      status: () => ({ phase: "serving", sessionId: "s1", unmet: [] }),
      requestReturnToWindows: async () => reply,
    });
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await sendControl(path, "status")).toEqual({ phase: "serving", sessionId: "s1", unmet: [] });
      expect(await sendControl(path, "return-to-windows")).toEqual({ ok: false, reason: "session-live" });
      reply = { ok: true };
      expect(await sendControl(path, "return-to-windows")).toEqual({ ok: true });
      expect(await sendControl(path, "reboot" as "status")).toEqual({ error: "unknown-command" });
    } finally {
      server.close();
    }
  });

  it("takes over a socket file an earlier run left behind", async () => {
    const path = join(await dir(), "control.sock");
    await writeFile(path, "");
    const server = await serveControl(path, {
      status: () => ({ phase: "offered", sessionId: null, unmet: [] }),
      requestReturnToWindows: async () => ({ ok: true }),
    });
    server.close();
  });
});

describe("the streamer", () => {
  // Runs as this test's own user: the launcher sets a uid and gid, and only root may set another's.
  const self = { uid: process.getuid!(), gid: process.getgid!() };

  /** A streamer that writes what it was given to `out`, then waits to be stopped. */
  const script = (out: string) => `
    const fs = require("node:fs");
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
        stdin: input, argv: process.argv.slice(1),
        env: { url: process.env.SWIFF_SERVER_URL, host: process.env.SWIFF_HOST_ID, appid: process.env.SWIFF_APPID,
               leaked: Object.keys(process.env).filter((k) => /KEY|SECRET/.test(k)) },
      }));
    });
    setInterval(() => {}, 1000);
  `;

  it("gets the session key on stdin only, and stops when asked", async () => {
    const out = join(await dir(), "seen.json");
    const launch = streamerLauncher(
      { command: process.execPath, args: ["-e", script(out)], ...self },
      "wss://swiff.example",
      "pc-1",
    );
    const streamer = launch(
      { sessionId: "s1", sessionKey: "the-session-key", expiresAt: 1_700_000_300 },
      730,
    );
    const deadline = Date.now() + 5_000;
    let seen: { stdin: string; argv: string[]; env: Record<string, unknown> } | null = null;
    while (!seen && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await readFile(out, "utf8")
        .then(JSON.parse)
        .catch(() => null);
    }
    expect(JSON.parse(seen!.stdin)).toEqual({ sessionKey: "the-session-key", expiresAt: 1_700_000_300 });
    expect(seen!.argv.join(" ")).not.toContain("the-session-key");
    expect(seen!.env).toEqual({ url: "wss://swiff.example", host: "pc-1", appid: "730", leaked: [] });
    await streamer.stop();
    await streamer.exited;
  });

  it("counts a streamer that cannot start as exited", async () => {
    const launch = streamerLauncher(
      { command: "/nonexistent/swiff-streamer", args: [], ...self },
      "ws://x",
      "pc-1",
    );
    const streamer = launch({ sessionId: "s1", sessionKey: "k", expiresAt: 0 }, null);
    await streamer.exited;
    await streamer.stop();
  });
});

describe("the resume file", () => {
  it("notes the boot a renter was served in until it is forgotten", async () => {
    const stateDir = join(await dir(), "state");
    const store = fileResumeStore(stateDir);
    expect(await store.servedBoot()).toBeNull();
    await store.markServed("boot-1");
    expect(await fileResumeStore(stateDir).servedBoot()).toBe("boot-1");
    await store.forgetServed();
    expect(await store.servedBoot()).toBeNull();
  });

  it("is read once", async () => {
    const store = fileResumeStore(join(await dir(), "state"));
    expect(await store.take()).toBeNull();
    await store.save({ until: 1_700_000_000_000 });
    expect(await store.take()).toEqual({ until: 1_700_000_000_000 });
    expect(await store.take()).toBeNull();
    await store.save({ until: null });
    expect(await store.take()).toEqual({ until: null });
  });
});
