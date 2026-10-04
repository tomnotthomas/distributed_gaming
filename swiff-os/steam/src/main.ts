// swiff-steam-login: the renter session's Steam, run by gamescope as its only
// program (see ../session). It starts Steam at its sign-in window and serves
// Plays on its local socket (serve.ts) until Steam exits, which ends the
// session; the machine restarts clean before the next renter.
//
//   SWIFF_STEAM_SOCKET  where to listen; default /run/swiff/steam/login.sock

import { serveLogin } from "./serve.ts";
import { startSteam, steamClient } from "./steam.ts";
import { x11Display } from "./x11.ts";

const socketPath = process.env.SWIFF_STEAM_SOCKET ?? "/run/swiff/steam/login.sock";

const steam = startSteam();
// Listen before anything is awaited: Steam can fail to start, or exit, while the socket is set up.
const exited = new Promise<number>((resolve) => {
  steam.once("error", (cause) => {
    console.error(`[swiff-steam-login] Steam did not start: ${cause.message}`);
    resolve(1);
  });
  steam.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
const server = await serveLogin(socketPath, { steam: steamClient(), display: x11Display() });
const code = await exited;
server.close();
process.exit(code);
