// Getting Steam ready on this PC: installed, signed in to the owner's own
// account, and games installed. Swiff never sees the owner's Steam account:
// they sign in, and install, in Steam's own window.

import { count } from "../format";
import { OPEN_STEAM_URL, type HostView } from "../model";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Kv, Plate, Zone } from "../ui/parts";
import { Notice } from "../ui/Notice";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

const yes = (on: boolean | undefined, reading: boolean) => (reading ? "…" : on ? "Yes" : "No");

/** The statement at the top: the one thing to do next. */
function statement({ steam, games }: HostView): { title: string; line: string } {
  const { status } = steam;
  if (!status)
    return { title: "Looking for Steam", line: "Players stream the games this PC's Steam has installed." };
  if (!status.installed)
    return {
      title: "Install Steam",
      line: "Players stream the games this PC's Steam has installed. Swiff downloads Valve's own installer and opens it; you click through it.",
    };
  if (!status.signedIn)
    return {
      title: "Sign in to Steam",
      line: "Sign in with your own Steam account, in Steam's own window. Swiff never asks for or sees your Steam password.",
    };
  return {
    title: "Steam is ready",
    line: games.installed.length
      ? "Install the games players ask for, and keep the ones you have."
      : "Install the games players ask for: any you own, or free to play.",
  };
}

/** Steam on this PC, and the next step to get it ready to host. */
export function SteamSetup({ view, actions, go }: ScreenProps) {
  const { status, installer, installs } = view.steam;
  const reading = status === null;
  const { title, line } = statement(view);
  const checks = [status?.installed, status?.signedIn, view.games.installed.length > 0];
  const ready = checks.filter(Boolean).length;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Steam</p>
          <h1>{title}</h1>
          <p className="ln">{line}</p>
          <p className="ln soft">
            Players always play with their own Steam copy of a game. Installing one here only puts its files
            on this PC: a player who does not own it cannot play it.
          </p>
        </div>
        <Plate caption={["Steam", reading ? "Reading" : ready === checks.length ? "Ready" : "Setting up"]}>
          <Dial
            progress={reading ? 0 : ready / checks.length}
            big={reading ? "…" : `${ready} of ${checks.length}`}
            small="ready"
          />
        </Plate>
      </section>

      <div className="sz three">
        <Zone title="Steam">
          <Kv label="Installed">{yes(status?.installed, reading)}</Kv>
          <Kv label="Running">{yes(status?.running, reading)}</Kv>
          {status && !status.installed ? (
            <div className="acts">
              <Pill icon="download" onClick={actions.installSteam} disabled={installer.kind === "fetching"}>
                {installer.kind === "fetching" ? "Downloading" : "Get Steam"}
              </Pill>
            </div>
          ) : null}
          {installer.kind === "fetching" ? (
            <Notice icon="download">Downloading Valve's installer.</Notice>
          ) : null}
          {installer.kind === "opened" && !status?.installed ? (
            <Notice>
              Valve's installer is open: follow its steps. This screen moves on once Steam is installed.
            </Notice>
          ) : null}
          {installer.kind === "failed" ? <Notice icon="warning">{installer.error}</Notice> : null}
        </Zone>
        <Zone title="Your Steam account">
          <Kv label="Signed in">{yes(status?.signedIn, reading)}</Kv>
          <p className="soft zl">
            You sign in to Steam itself, with your own account. Swiff never asks for your password.
          </p>
          {status?.installed && !status.signedIn ? (
            <div className="acts">
              <a className="inst" href={OPEN_STEAM_URL} target="_blank" rel="noreferrer">
                <Glyph name="arrow" size={15} />
                Open Steam to sign in
              </a>
            </div>
          ) : null}
        </Zone>
        <Zone title="Next">
          <p className="soft">
            {installs.length
              ? `Steam is installing ${count(installs.length, "game", "games")}.`
              : "See the games players ask for, and install any you own or that are free to play."}
          </p>
          <div className="acts">
            <Pill icon="arrow" onClick={() => go("games")}>
              Choose games
            </Pill>
          </div>
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
