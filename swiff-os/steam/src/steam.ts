// The Steam client, from the outside: started without its library window,
// asked to launch a game, and watched for being signed in. Only Steam's
// documented command line and the log it keeps in the renter's home are used.
//
//   steam -silent              start at the sign-in window; once signed in, no library window
//   steam -applaunch <appid>   hand the running client a game to launch
//   ~/.steam/registry.vdf      its settings; RememberPassword "0" leaves "Remember me"
//                              unticked, so a sign-in is not kept for the next start
//   ~/.steam/steam/logs/steamui_login.txt
//                              each step of its sign-in, "SetLoginState: <state> - OK":
//                              WaitingForCredentials, WaitingForServerResponse,
//                              WaitingForLibraryReady, then Success once signed in
//
// Steam is told not to remember the sign-in, and the renter's home is wiped with
// the machine after every session, and with it whatever Steam keeps of it.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Steam's sign-in QR codes encode a link like https://s.team/q/1/1234567890123456789. */
const SIGN_IN_URL = /^https:\/\/s\.team\/q\/[0-9]+\/[0-9]+$/;

/** Whether `text`, read off a QR code on Steam's window, is a Steam sign-in link. */
export const isSignInUrl = (text: string): boolean => SIGN_IN_URL.test(text);

/** The sign-in state Steam last logged in steamui_login.txt, or null before it logs one. */
export function lastLoginState(log: string): string | null {
  const states = [...log.matchAll(/SetLoginState: (\w+)/g)];
  return states.at(-1)?.[1] ?? null;
}

export type SteamClient = {
  /** Whether an account is signed in to the running client. */
  signedIn(): Promise<boolean>;
  /** Have the running client launch `appid`. Rejects when `steam` cannot be run at all. */
  launch(appid: number): Promise<void>;
};

/** The Steam client of the renter whose home is `home`. */
export function steamClient(home = homedir()): SteamClient {
  return {
    /** Signed in once Steam's sign-in log last says `Success`; no log yet means not. */
    async signedIn() {
      try {
        const log = await readFile(join(home, ".steam", "steam", "logs", "steamui_login.txt"), "utf8");
        return lastLoginState(log) === "Success";
      } catch {
        return false; // Steam has not written it yet: still starting
      }
    },
    launch: (appid) =>
      new Promise((resolve, reject) => {
        // The second `steam` hands its arguments to the running client and exits.
        const child = spawn("steam", ["-applaunch", String(appid)], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", () => resolve());
      }),
  };
}

/** Steam's settings for the renter: no account to sign in to by itself, nothing remembered. */
const REGISTRY = `"Registry"
{
	"HKCU"
	{
		"Software"
		{
			"Valve"
			{
				"Steam"
				{
					"AutoLoginUser"		""
					"RememberPassword"		"0"
				}
			}
		}
	}
}
`;

/**
 * Start the Steam client at its sign-in window, without its library window,
 * set not to remember the renter's sign-in.
 */
export function startSteam(home = homedir()): ChildProcess {
  mkdirSync(join(home, ".steam"), { recursive: true });
  writeFileSync(join(home, ".steam", "registry.vdf"), REGISTRY);
  // Its console output stays out of the journal: it can name the account.
  return spawn("steam", ["-silent"], { stdio: "ignore", env: { ...process.env, HOME: home } });
}
