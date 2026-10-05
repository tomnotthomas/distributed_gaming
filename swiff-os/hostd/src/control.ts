// The local control socket: how the PC's own status page asks the agent where
// it stands, and how the owner at the PC asks for it back. One command per
// connection, one JSON line back:
//
//   status             → { "phase": "offered", "sessionId": null, "unmet": [] }
//   return-to-windows  → { "ok": true } | { "ok": false, "reason": "session-live" | "busy" }
//
// The socket is root's alone (mode 600) until the status page has a user of its own.

import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import type { Agent } from "./agent.ts";

export const COMMANDS = ["status", "return-to-windows"] as const;
export type Command = (typeof COMMANDS)[number];

const MAX_COMMAND_BYTES = 64;

export async function serveControl(
  path: string,
  agent: Pick<Agent, "status" | "requestReturnToWindows">,
): Promise<Server> {
  // A socket file left by an earlier run would refuse the listen.
  await rm(path, { force: true });
  const server = createServer((conn) => {
    let text = "";
    let answered = false;
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("data", async (chunk: string) => {
      if (answered) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1 && text.length <= MAX_COMMAND_BYTES) return;
      answered = true;
      const command = text.slice(0, end === -1 ? undefined : end).trim();
      const reply =
        command === "status"
          ? agent.status()
          : command === "return-to-windows"
            ? await agent.requestReturnToWindows()
            : { error: "unknown-command" };
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return server;
}

/** Send `command` to the agent listening at `path`, and resolve with its reply. */
export function sendControl(path: string, command: Command): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path, () => conn.write(`${command}\n`));
    let text = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => (text += chunk));
    conn.on("error", reject);
    conn.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("the agent's reply is not JSON"));
      }
    });
  });
}
