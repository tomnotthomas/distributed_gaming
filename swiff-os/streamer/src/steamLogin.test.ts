// The forwarder against a real Unix socket standing in for swiff-steam-login:
// what it asks the agent, what reaches the renter, and what stays on the PC.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalMessage } from "@swiff/rtc";
import { steamLoginForwarder, type SteamLoginForwarder } from "./steamLogin";

const QR_1 = "https://s.team/q/1/1111111111111111111";
const QR_2 = "https://s.team/q/1/2222222222222222222";

let dir: string;
let path: string;
let agent: Server;
/** What the agent was asked, and its end of each connection. */
let commands: string[];
let conns: Socket[];
let forwarder: SteamLoginForwarder | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "swiff-steam-login-"));
  path = join(dir, "login.sock");
  commands = [];
  conns = [];
  forwarder = null;
  agent = createServer((conn) => {
    conns.push(conn);
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => commands.push(chunk));
  });
  await new Promise<void>((resolve) => agent.listen(path, resolve));
});

afterEach(async () => {
  forwarder?.stop();
  conns.forEach((c) => c.destroy());
  await new Promise((resolve) => agent.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

/** The agent sends these PlayEvents, one per line. */
const agentSays = (...events: object[]) =>
  conns.at(-1)!.write(events.map((e) => `${JSON.stringify(e)}\n`).join(""));

const start = (log = vi.fn(), appid = 1245620) => {
  forwarder = steamLoginForwarder({ socketPath: path, appid, log });
  return log;
};

describe("steamLoginForwarder", () => {
  it("asks the agent to play the game once the renter joins, relays each code, then signed-in, and says when the game runs", async () => {
    const log = start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));

    await vi.waitFor(() => expect(commands.join("")).toBe("play 1245620\n"));
    // The renter's first frame: the server asks the PC to launch the game.
    forwarder!.launchGame("s-1", 1245620, (m) => sent.push(m));
    agentSays(
      { event: "qr", url: QR_1, atMs: 40 },
      { event: "qr", url: QR_2, atMs: 21_000 },
      { event: "signed-in", atMs: 30_000 },
      { event: "launching", appid: 1245620, atMs: 30_100 },
      { event: "game-on-screen", appid: 1245620, atMs: 41_000 },
    );

    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("on screen at 41000 ms")),
    );
    expect(sent).toEqual([
      { type: "steam-login", state: "qr", url: QR_1 },
      { type: "steam-login", state: "qr", url: QR_2 },
      { type: "steam-login", state: "signed-in" },
      { type: "game-started", sessionId: "s-1" },
    ]);
    expect(commands.join("")).toBe("play 1245620\n");
    // A code is a live sign-in: it goes to the renter and is never logged.
    expect(log.mock.calls.flat().join("\n")).not.toContain("s.team");
    // The game is up; the agent closing the socket is not a failure.
    conns[0]!.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(4);
  });

  it("answers each launch-game once the game runs, and plays hostd's game whatever launch-game names", async () => {
    const log = start(vi.fn(), 730);
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(commands.join("")).toBe("play 730\n"));

    forwarder!.launchGame("s-1", 440, (m) => sent.push(m));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("names app 440, not 730; playing 730"));
    expect(sent).toEqual([]);
    agentSays({ event: "signed-in", atMs: 10 }, { event: "game-on-screen", appid: 730, atMs: 9_000 });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "game-started", sessionId: "s-1" }));

    // A reconnect starts the session again: the game already runs, so the answer is at once.
    forwarder!.launchGame("s-1", 730, (m) => sent.push(m));
    expect(sent.filter((m) => m.type === "game-started")).toHaveLength(2);
    expect(conns).toHaveLength(1);
    expect(commands.join("")).toBe("play 730\n");
  });

  it("starts the Play once, and sends a renter who joins again where the sign-in stands", async () => {
    start();
    forwarder!.renterJoined(() => {});
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays({ event: "qr", url: QR_1, atMs: 40 });
    await new Promise((r) => setTimeout(r, 50));

    const again: SignalMessage[] = [];
    forwarder!.renterJoined((m) => again.push(m));
    expect(again).toEqual([{ type: "steam-login", state: "qr", url: QR_1 }]);
    agentSays({ event: "qr", url: QR_2, atMs: 21_000 });
    await vi.waitFor(() => expect(again).toHaveLength(2));
    expect(conns).toHaveLength(1);
    expect(commands.join("")).toBe("play 1245620\n");
  });

  it("tells the renter the sign-in failed when the agent says so", async () => {
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays(
      { event: "qr", url: QR_1, atMs: 40 },
      { event: "failed", reason: "sign-in-timeout", atMs: 600_000 },
    );
    conns[0]!.end();

    await vi.waitFor(() =>
      expect(sent.at(-1)).toEqual({ type: "steam-login", state: "failed", reason: "sign-in-timeout" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((m) => m.type === "steam-login" && m.state === "failed")).toHaveLength(1);
  });

  it("passes on why the game never came up, and no reason for a failure the page has no copy for", async () => {
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays({ event: "signed-in", atMs: 10 }, { event: "failed", reason: "launch-timeout", atMs: 90_000 });
    await vi.waitFor(() =>
      expect(sent.at(-1)).toEqual({ type: "steam-login", state: "failed", reason: "launch-timeout" }),
    );

    forwarder!.retry((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(2));
    agentSays({ event: "failed", reason: "busy", atMs: 0 });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "steam-login", state: "failed" }));
  });

  it("starts a fresh Play when the renter retries after a failure, and relays its new code", async () => {
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays({ event: "failed", reason: "sign-in-timeout", atMs: 600_000 });
    conns[0]!.end();
    await vi.waitFor(() =>
      expect(sent).toEqual([{ type: "steam-login", state: "failed", reason: "sign-in-timeout" }]),
    );

    forwarder!.retry((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(2));
    await vi.waitFor(() => expect(commands.join("")).toBe("play 1245620\nplay 1245620\n"));
    agentSays({ event: "qr", url: QR_2, atMs: 30 });

    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "steam-login", state: "qr", url: QR_2 }));
  });

  it("answers a retry while the Play is still under way with where it stands, without a second Play", async () => {
    start();
    forwarder!.renterJoined(() => {});
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays({ event: "qr", url: QR_1, atMs: 40 });
    await new Promise((r) => setTimeout(r, 50));

    const answered: SignalMessage[] = [];
    forwarder!.retry((m) => answered.push(m));
    expect(answered).toEqual([{ type: "steam-login", state: "qr", url: QR_1 }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(conns).toHaveLength(1);
  });

  it("fails the sign-in when the agent hangs up before the game is on screen", async () => {
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    agentSays({ event: "qr", url: QR_1, atMs: 40 }, { event: "signed-in", atMs: 9_000 });
    conns[0]!.destroy();

    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "steam-login", state: "failed" }));
  });

  it("fails the sign-in when there is no agent to ask", async () => {
    await new Promise((resolve) => agent.close(resolve));
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));

    await vi.waitFor(() => expect(sent).toEqual([{ type: "steam-login", state: "failed" }]));
  });

  it("hangs up on the agent when stopped, which stops the Play, and tells the renter nothing", async () => {
    start();
    const sent: SignalMessage[] = [];
    forwarder!.renterJoined((m) => sent.push(m));
    await vi.waitFor(() => expect(conns).toHaveLength(1));
    const closed = new Promise((resolve) => conns[0]!.once("close", resolve));

    forwarder!.stop();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });
});
