// The first run: read this PC, and, after Steam (Steam.tsx), the games players can stream.

import { useId, useState } from "react";
import { count, shortGpu } from "../format";
import {
  appidIn,
  installShare,
  installUrl,
  STEAM_LIBRARY_URL,
  type DemandRow,
  type Game,
  type SteamInstall,
} from "../model";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Notice } from "../ui/Notice";
import { Art, Eur, Figure, Kv, Plate, Zone } from "../ui/parts";
import { Pill } from "../ui/Pill";
import { listedGames, type ScreenProps } from "./types";

/** A1: what the app read about this PC, part by part. */
export function ReadPc({ view, go, setupDone }: ScreenProps & { setupDone: boolean }) {
  const { reading, hardware: hw, hardwareRate } = view.pc;
  const parts = [hw?.gpu, hw?.cpu, hw?.ramGb, hw?.upMbps ?? hw?.display];
  const read = parts.filter((part) => part != null).length;
  const games = view.games.installed.length;
  const display = hw?.display;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{setupDone ? "This PC" : "First run"}</p>
          <h1>Reading this PC</h1>
          {hardwareRate !== null ? (
            <Figure unit="an hour, hardware rate">
              <Eur n={hardwareRate} />
            </Figure>
          ) : null}
          <p className="ln">
            {hardwareRate !== null
              ? "Your reliability and level adjust it. The rate is fixed while a player is on."
              : "The parts that decide which games this PC can run for players."}
          </p>
        </div>
        <Plate caption={["Hardware", reading ? "Reading" : hardwareRate !== null ? "Rate found" : "Read"]}>
          <Dial
            progress={reading ? 0 : read / parts.length}
            big={reading ? "…" : `${read} of ${parts.length}`}
            small="parts read"
          />
        </Plate>
      </section>

      <div className="sz three">
        <Zone title="Graphics and processor">
          <Kv label="GPU">{hw?.gpu ? shortGpu(hw.gpu) : reading ? "…" : "Not found"}</Kv>
          <Kv label="CPU">{hw?.cpu ?? (reading ? "…" : "Not found")}</Kv>
        </Zone>
        <Zone title={hw?.upMbps ? "Memory and network" : "Memory and display"}>
          <Kv label="Memory">{hw?.ramGb ? `${hw.ramGb} GB` : reading ? "…" : "Not found"}</Kv>
          {hw?.upMbps ? (
            <Kv label="Connection">{hw.upMbps >= 1000 ? `${hw.upMbps / 1000} Gbit` : `${hw.upMbps} Mbit`}</Kv>
          ) : (
            <Kv label="Display">
              {display
                ? `${display.width} × ${display.height}${display.refreshHz ? `, ${display.refreshHz} Hz` : ""}`
                : reading
                  ? "…"
                  : "Not found"}
            </Kv>
          )}
        </Zone>
        <Zone title="Next">
          <p className="soft">
            {games
              ? `${count(games, "game is", "games are")} installed.${view.games.offered ? " Choose which ones players can stream." : ""}`
              : reading
                ? "Looking for installed Steam games."
                : "No installed Steam games were found on this PC."}
          </p>
          <div className="acts">
            <Pill icon="arrow" onClick={() => go("steam")} disabled={reading}>
              Set up Steam
            </Pill>
          </div>
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** Ten ticks for demand, filled against the busiest game (or 40 players, whichever is more). */
function DemandTicks({ looking, top }: { looking: number; top: number }) {
  const on = Math.min(10, Math.floor((looking / Math.max(40, top)) * 10));
  return (
    <span className="dt" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} className={i < on ? "on" : undefined} />
      ))}
    </span>
  );
}

type Row = { game: Game; rank: number | null; demand: DemandRow | null; installed: boolean };

/**
 * Ranked by demand where Swiff reports it, then the games Steam is
 * installing, then the installed games by name.
 */
function rows(installed: Game[], demand: DemandRow[] | null, installing: SteamInstall[]): Row[] {
  const has = (appid: number) => installed.some((g) => g.appid === appid);
  const ranked: Row[] = (demand ?? []).map((d, i) => ({
    game: { appid: d.appid, name: d.name },
    rank: i + 1,
    demand: d,
    installed: has(d.appid),
  }));
  const listed = (appid: number) => ranked.some((r) => r.game.appid === appid);
  const pending = installing
    .filter((i) => !listed(i.appid) && !has(i.appid))
    .map(({ appid, name }) => ({ game: { appid, name }, rank: null, demand: null, installed: false }));
  const rest = installed
    .filter((g) => !listed(g.appid))
    .map((game) => ({ game, rank: null, demand: null, installed: true }));
  return [...ranked, ...pending, ...rest];
}

const PHASE: Record<SteamInstall["phase"], string> = {
  queued: "Queued in Steam",
  downloading: "Downloading",
  finishing: "Finishing",
  paused: "Paused",
};

/** How far Steam is with one game, from its own files. */
function Progress({ install }: { install: SteamInstall }) {
  const share = installShare(install);
  const pct = share === null ? null : Math.floor(share * 100);
  return (
    <span className="gprog">
      <span
        className="gbar"
        role="progressbar"
        aria-label={`Installing ${install.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <i style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="mono gst">
        {PHASE[install.phase]}
        {pct !== null && install.phase !== "queued" ? ` ${pct}%` : ""}
      </span>
    </span>
  );
}

/** A game this PC lacks: its install under way, waiting on the owner in Steam, or the link to install it. */
function Missing({ appid, view, actions, go }: ScreenProps & { appid: number }) {
  const { status, installs, asked } = view.steam;
  const install = installs.find((i) => i.appid === appid);
  if (install) return <Progress install={install} />;
  if (asked.includes(appid)) return <span className="mono gst">Confirm in Steam</span>;
  if (status && !status.installed) {
    return (
      <button type="button" className="inst" onClick={() => go("steam")}>
        Install Steam first
      </button>
    );
  }
  return (
    <a
      className="inst"
      href={installUrl(appid)}
      target="_blank"
      rel="noreferrer"
      onClick={() => actions.askInstall(appid)}
    >
      <Glyph name="download" size={15} />
      Install on Steam
    </a>
  );
}

/** Any game the owner's Steam account has, by its store link or appid, and their library in Steam. */
function InstallAny({ view, actions }: ScreenProps) {
  const id = useId();
  const [text, setText] = useState("");
  const appid = appidIn(text);
  const has = appid !== null && view.games.installed.some((g) => g.appid === appid);
  return (
    <div className="ginst">
      <div className="fld">
        <label className="mono" htmlFor={id}>
          Install any game you own
        </label>
        <input
          id={id}
          value={text}
          placeholder="Steam store link or app id"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
        />
        <small id={`${id}-hint`}>
          {has
            ? "That game is installed already."
            : "Paid games install only if your account owns them; free to play ones always do."}
        </small>
      </div>
      {appid !== null && !has ? (
        <a
          className="inst"
          href={installUrl(appid)}
          target="_blank"
          rel="noreferrer"
          onClick={() => actions.askInstall(appid)}
        >
          <Glyph name="download" size={15} />
          Install on Steam
        </a>
      ) : (
        <span className="inst off" aria-disabled="true">
          <Glyph name="download" size={15} />
          Install on Steam
        </span>
      )}
      <a className="inst" href={STEAM_LIBRARY_URL} target="_blank" rel="noreferrer">
        <Glyph name="arrow" size={15} />
        Open your Steam library
      </a>
    </div>
  );
}

/**
 * A2: which installed games players can stream here, with demand where Swiff
 * reports it. Read-only where the choice has no effect yet.
 */
export function Games({ view, actions, go, finishSetup }: ScreenProps & { finishSetup: () => void }) {
  const { installed, offered, demand } = view.games;
  const toggle = offered ? actions.toggleOffer : null;
  const top = demand?.[0]?.looking ?? 0;
  const list = rows(installed, demand, view.steam.installs);
  const steamMissing = view.steam.status !== null && !view.steam.status.installed;

  return (
    <main className="step">
      <section className="hz games">
        <div className="cp">
          <p className="mono ctx">{demand ? "Demand, last hour" : "Installed on this PC"}</p>
          <h1>{toggle ? "Choose the games you offer" : "Your installed games"}</h1>
          <p className="ln">
            Players can stream a game only if they own it too: they play with their own Steam copy, and
            installing it here only puts its files on this PC.
            {demand ? " Offer the games you have; install the popular ones you don't." : ""}
            {toggle ? "" : " Choosing which ones to offer comes with a later update."}
          </p>
        </div>
        <div className="gcount">
          <b>{listedGames(view).length}</b>
          {toggle ? (
            <span className="mono">
              of {installed.length} installed
              <br />
              games offered
            </span>
          ) : (
            <span className="mono">
              installed
              <br />
              {installed.length === 1 ? "game" : "games"}
            </span>
          )}
        </div>
      </section>

      {list.length ? (
        <div className="ggrid">
          {list.map(({ game, rank, demand: d, installed: has }) => {
            const on = has && Boolean(offered?.includes(game.appid));
            const body = (
              <>
                <span className="gimg">
                  <Art appid={game.appid} />
                </span>
                <span className="gtop">
                  {rank !== null ? <span className="rk">{String(rank).padStart(2, "0")}</span> : null}
                  <b>{game.name}</b>
                </span>
                {d ? (
                  <span className="gdem">
                    <DemandTicks looking={d.looking} top={top} />
                    <span className="mono">
                      {d.looking} looking{d.waiting ? `, ${d.waiting} waiting` : ""}
                    </span>
                  </span>
                ) : null}
              </>
            );
            if (!has) {
              return (
                <div key={game.appid} className="gtile missing">
                  {body}
                  <span className="gact">
                    <Missing appid={game.appid} view={view} actions={actions} go={go} />
                  </span>
                </div>
              );
            }
            if (!toggle) {
              return (
                <div key={game.appid} className="gtile installed">
                  {body}
                  <span className="gact">
                    <span className="mono gst">Installed</span>
                  </span>
                </div>
              );
            }
            return (
              <button
                key={game.appid}
                type="button"
                className={["gtile", on ? "on offered" : "installed"].join(" ")}
                aria-pressed={on}
                onClick={() => toggle(game.appid)}
              >
                {body}
                <span className="gact">
                  <span className="gname2">
                    <span className={on ? "rad on" : "rad"} />
                    {on ? "Offered" : "Offer"}
                  </span>
                  {on ? null : <span className="mono gst">Installed</span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="empty soft">
          {view.pc.reading
            ? "Looking for installed Steam games."
            : "No installed Steam games were found on this PC yet. Each one shows here once Steam has installed it."}
        </p>
      )}

      {steamMissing ? (
        <Notice icon="info">
          Steam is not installed on this PC.{" "}
          <button type="button" className="inst" onClick={() => go("steam")}>
            Install Steam first
          </button>
        </Notice>
      ) : (
        <InstallAny view={view} actions={actions} go={go} />
      )}

      <div className="gfoot">
        <span className="soft">
          {demand
            ? "Demand is the number of players looking for a PC with that game in the last hour."
            : "Read from this PC's Steam library."}
        </span>
        <Pill
          icon="arrow"
          onClick={() => {
            finishSetup();
            go("live");
          }}
        >
          Continue
        </Pill>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
