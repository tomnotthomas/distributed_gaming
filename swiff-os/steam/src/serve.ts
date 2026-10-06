// The agent's local socket: how the streamer, which carries the renter's
// signaling, asks for a Play and hears how it goes. One command per
// connection:
//
//   play <appid>  → one PlayEvent per line (login.ts) until game-on-screen or failed, then closed
//
// A `qr` event carries a live sign-in code: whoever reads this socket passes it
// to the renter's page and nowhere else, and never logs it. Hanging up stops
// the play. One play runs at a time; a second gets { "event": "failed", "reason": "busy" },
// and a play the agent itself fails at ends with { "event": "failed", "reason": "error" }.

import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { play, type PlayOptions } from "./login.ts";

const MAX_COMMAND_BYTES = 64;

/**
 * Listen at `path`. The socket is for the agent's user and its group (mode
 * 660); the group is the streamer's, set on the directory it is made in.
 */
export async function serveLogin(path: string, opts: Omit<PlayOptions, "emit" | "signal">): Promise<Server> {
  await rm(path, { force: true });
  let playing = false;
  const server = createServer((conn) => {
    let text = "";
    let answered = false;
    const hangUp = new AbortController();
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("close", () => hangUp.abort());
    conn.on("data", async (chunk: string) => {
      if (answered) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1 && text.length <= MAX_COMMAND_BYTES) return;
      answered = true;
      const [command, arg] = text
        .slice(0, end === -1 ? undefined : end)
        .trim()
        .split(/\s+/);
      /** One JSON line to the streamer, unless it already hung up. */
      const write = (reply: object) => {
        if (!conn.destroyed) conn.write(`${JSON.stringify(reply)}\n`);
      };

      if (command === "play" && arg !== undefined && /^[1-9][0-9]{0,9}$/.test(arg)) {
        if (playing) {
          write({ event: "failed", reason: "busy", atMs: 0 });
        } else {
          playing = true;
          try {
            await play(Number(arg), { ...opts, emit: write, signal: hangUp.signal });
          } catch (cause) {
            console.error(
              `[swiff-steam-login] play failed: ${cause instanceof Error ? cause.message : cause}`,
            );
            write({ event: "failed", reason: "error", atMs: 0 });
          } finally {
            playing = false;
          }
        }
      } else {
        write({ error: "unknown-command" });
      }
      conn.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o660);
  return server;
}
