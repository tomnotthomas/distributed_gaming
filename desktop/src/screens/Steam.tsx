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

const yes = (on: boolean | undefined, reading: boolean) => (reading ? "Checking" : on ? "Yes" : "No");

/** The statement at the top: the one thing to do next. */
function statement({ steam, games, pairing }: HostView): { title: string; line: string } {
  const { status } = steam;
  if (!status)
    return { title: "Checking Steam", line: "Players play the games installed in Steam on this PC." };
  if (!status.installed)
    return {
      title: "Install Steam",
      line: "Lanterel downloads the Steam installer for you. Click through it like any other install.",
    };
  if (!status.signedIn)
    return {
      title: "Sign in to Steam",
      line: "Sign in with your own account in the Steam window. Lanterel never sees your password.",
    };
  return {
    title: "Steam is ready",
    line:
      pairing.kind !== "paired"
        ? "Next, pair this PC with your Steam account."
        : games.installed.length
          ? "Next, pick the games players can play."
          : "Next, install a few games. Free-to-play games work for every player.",
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
            Players need to own a game on Steam to play it here. Installing it only puts the files on this PC.
          </p>
        </div>
        <Plate
          caption={["Steam", reading ? "Checking now" : ready === checks.length ? "Ready" : "Setting up"]}
        >
          {/* Steam's read can take a while: the ring turns while it runs, so it never looks undone. */}
          <Dial
            live={reading}
            progress={reading ? null : ready / checks.length}
            big={reading ? "…" : `${ready} of ${checks.length}`}
            small={reading ? "checking" : "ready"}
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
          {installer.kind === "fetching" ? <Notice icon="download">Downloading Steam…</Notice> : null}
          {installer.kind === "opened" && !status?.installed ? (
            <Notice>The Steam installer is open. This screen updates when it's done.</Notice>
          ) : null}
          {installer.kind === "failed" ? <Notice icon="warning">{installer.error}</Notice> : null}
        </Zone>
        <Zone title="Your Steam account">
          <Kv label="Signed in">{yes(status?.signedIn, reading)}</Kv>
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
            {view.pairing.kind !== "paired"
              ? "Pair this PC with your Steam account, in one sign-in."
              : installs.length
                ? `Steam is installing ${count(installs.length, "game", "games")}.`
                : "See which games to install."}
          </p>
          <div className="acts">
            {view.pairing.kind !== "paired" ? (
              <Pill icon="arrow" onClick={() => go("pair")}>
                Pair this PC
              </Pill>
            ) : (
              <Pill icon="arrow" onClick={() => go("games")}>
                Choose games
              </Pill>
            )}
          </div>
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
