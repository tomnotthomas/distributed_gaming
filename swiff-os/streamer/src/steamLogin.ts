// Rental mode's Steam sign-in and launch, between the PC's Steam agent and the
// renter's page. swiff-steam-login (swiff-os/steam) runs the renter session's
// Steam and serves Plays on a local socket; the streamer carries the renter's
// signaling, so it asks for the Play and relays how it goes:
//
//   renter joins ──► `play <appid>` on the agent's socket
//   agent: qr ×n, signed-in, failed ──► steam-login to the renter
//   renter: steam-login retry, after failed ──► a fresh `play <appid>`
//   agent: game-on-screen, and the server's launch-game ──► game-started
//
// The Play starts as soon as the renter is in the room, before the stream
// connects, so the page has Steam's code while it is still on Ignition. The
// game is hostd's SWIFF_APPID, or, without one, the one the server's
// launch-game names. A renter who reloads joins again and is sent where the
// sign-in stands. The page shows the stream only on game-started, which goes
// once the game is on screen, for every launch-game the server sends. Hanging
// up the socket stops the Play.
//
// A `qr` event carries a live sign-in code: it goes to the renter's page and
// nowhere else, and is never logged.

import { createConnection, type Socket } from "node:net";
import type { SignalMessage } from "@swiff/rtc";

type SteamLogin = Extract<SignalMessage, { type: "steam-login" }>;
type Send = (msg: SignalMessage) => void;

/** One line from the agent's socket (swiff-os/steam/src/login.ts's PlayEvent, loosely). */
type AgentEvent = { event?: unknown; url?: unknown; reason?: unknown; atMs?: unknown };

/** An agent line past this is not the agent talking. */
const MAX_LINE_BYTES = 4096;

export type SteamLoginOptions = {
  /** The agent's socket, as swiff-steam-login's SWIFF_STEAM_SOCKET. */
  socketPath: string;
  /** The game booked, when hostd said; otherwise the server's launch-game says. */
  appid: number | null;
  /** Stand-in for node:net, so tests can use their own socket. */
  connect?: (path: string) => Socket;
  log?: (message: string) => void;
};

export type SteamLoginForwarder = {
  /** The renter joined (again): start the Play once, and send them where it stands. */
  renterJoined(send: Send): void;
  /**
   * The renter asked for a new code. After a failed Play that is a fresh one;
   * otherwise the Play under way answers, so they are sent where it stands.
   */
  retry(send: Send): void;
  /** The server's launch-game: answered with game-started once the game is on screen. */
  launchGame(sessionId: string, appid: number, send: Send): void;
  /** Hang up on the agent, which stops the Play. */
  stop(): void;
};

export function steamLoginForwarder({
  socketPath,
  appid: hostdAppid,
  connect = createConnection,
  log = (m) => console.error(m),
}: SteamLoginOptions): SteamLoginForwarder {
  let appid = hostdAppid;
  let socket: Socket | null = null;
  let send: Send | null = null;
  /** Where the sign-in stands, for a renter who joins again. */
  let latest: SteamLogin | null = null;
  /** The Play is over: the game is on screen, or it failed. */
  let finished = false;
  let onScreen = false;
  /** The session of the latest launch-game, to answer once the game is on screen. */
  let launchSession: string | null = null;
  let stopped = false;

  const tell = (msg: SteamLogin) => {
    latest = msg;
    send?.(msg);
  };

  const answerLaunch = () => {
    if (onScreen && launchSession) send?.({ type: "game-started", sessionId: launchSession });
  };

  /** The Play is over without the game on screen: the renter's page offers to try again. */
  const fail = (why: string) => {
    if (finished || stopped) return;
    finished = true;
    log(`[swiff-streamer] Steam sign-in failed (${why})`);
    tell({ type: "steam-login", state: "failed" });
  };

  const onEvent = (line: string) => {
    if (finished) return;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      return fail("the agent sent something that is not an event");
    }
    const atMs = typeof event.atMs === "number" ? ` at ${event.atMs} ms` : "";
    switch (event.event) {
      case "qr":
        if (typeof event.url === "string") tell({ type: "steam-login", state: "qr", url: event.url });
        break;
      case "signed-in":
        log(`[swiff-streamer] Steam signed in${atMs}`);
        tell({ type: "steam-login", state: "signed-in" });
        break;
      case "launching":
        log(`[swiff-streamer] Steam is launching the game${atMs}`);
        break;
      case "game-on-screen":
        finished = true;
        onScreen = true;
        log(`[swiff-streamer] the game is on screen${atMs}`);
        answerLaunch();
        break;
      case "failed":
        fail(typeof event.reason === "string" ? event.reason : "unknown");
        break;
    }
  };

  const startPlay = (game: number) => {
    finished = false;
    onScreen = false;
    latest = null;
    const conn = connect(socketPath);
    socket = conn;
    let text = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`play ${game}\n`));
    conn.on("data", (chunk: string) => {
      text += chunk;
      let end: number;
      while ((end = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        if (line.trim()) onEvent(line);
      }
      if (text.length > MAX_LINE_BYTES) {
        fail("the agent sent a line too long");
        conn.destroy();
      }
    });
    // A socket a retry replaced says nothing more.
    conn.on("error", (cause) => socket === conn && fail(`the agent's socket: ${cause.message}`));
    conn.on("close", () => socket === conn && fail("the agent hung up"));
  };

  return {
    renterJoined(to) {
      send = to;
      if (stopped) return;
      if (!socket) {
        if (appid !== null) startPlay(appid);
      } else if (latest) to(latest);
    },
    retry(to) {
      send = to;
      if (stopped || appid === null) return;
      if (!socket || (finished && !onScreen)) {
        socket?.destroy();
        startPlay(appid);
      } else if (latest) to(latest);
    },
    launchGame(sessionId, game, to) {
      send = to;
      if (stopped) return;
      if (appid !== null && appid !== game) {
        log(`[swiff-streamer] launch-game names app ${game}, not ${appid}; playing ${appid}`);
      }
      appid ??= game;
      launchSession = sessionId;
      if (!socket) startPlay(appid);
      answerLaunch();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      socket?.destroy();
    },
  };
}
