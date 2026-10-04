// swiff-streamer: serves one renter session from a Swiff OS host.
//
// Started by swiff-hostd as the swiff-stream user (see config.ts for what it is
// given). It reads the session grant from stdin, creates the virtual input
// devices, starts the capture and registers with the session key, all at once,
// so the picture is ready by the time the renter's browser answers. It exits:
//
//   0  the server put it out (the session ended, or the key is refused), or SIGTERM
//   1  it cannot serve: no working encoder, or a setting is wrong
//
// swiff-hostd treats every exit alike and decides from the session what comes
// next, so the codes are for the journal, not for it.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCapture, type Capture } from "./capture";
import { ConfigError, parseGrant, readConfig } from "./config";
import { startStreamer, type Streamer } from "./streamer";
import { startVirtualInput, type VirtualInput } from "./uinput";

/** The grant is one short line; anything past this is not hostd talking. */
const MAX_GRANT_BYTES = 4096;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_GRANT_BYTES) throw new ConfigError("stdin is longer than a session grant");
  }
  return text;
}

async function main(): Promise<number> {
  // dist/swiff-streamer.mjs and src/main.ts both sit one level below the helpers' parent.
  const here = dirname(fileURLToPath(import.meta.url));
  const config = readConfig(process.env, process.argv.slice(2), join(here, "..", "helpers"));
  const grant = parseGrant(await readStdin());

  let input: VirtualInput | null = null;
  let capture: Capture | null = null;
  let streamer: Streamer | null = null;
  const shutdown = async () => {
    streamer?.stop();
    await Promise.all([capture?.stop(), input?.stop()]);
  };

  input = config.input ? startVirtualInput({ config }) : null;
  streamer = startStreamer({
    config,
    grant,
    input: input?.sink ?? null,
    onKeyframeNeeded: () => capture?.requestKeyframe(),
  });

  const stopped = new Promise<"signal">((resolve) => {
    process.once("SIGTERM", () => resolve("signal"));
    process.once("SIGINT", () => resolve("signal"));
  });
  // The journal says when each medium first flows, not every packet.
  const flowing = new Set<string>();
  const captured = startCapture({
    config,
    onPacket: (kind, packet) => {
      if (!flowing.has(kind)) {
        flowing.add(kind);
        console.error(`[swiff-streamer] ${kind} capture is flowing`);
      }
      streamer?.send(kind, packet);
    },
  });

  try {
    const first = await Promise.race([captured, streamer.ended, stopped]);
    if (typeof first === "object") {
      capture = first;
      await Promise.race([streamer.ended, stopped]);
    }
    return 0;
  } catch (cause) {
    console.error(`[swiff-streamer] ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  } finally {
    // A capture still being set up when the session ended is stopped once it is.
    if (!capture) void captured.then((c) => c.stop()).catch(() => {});
    await shutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(`[swiff-streamer] ${cause instanceof Error ? cause.message : cause}`);
    process.exit(1);
  },
);
