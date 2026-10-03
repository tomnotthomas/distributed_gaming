// The first run: read this PC, then the games players can stream.

import { count, shortGpu } from "../format";
import { installUrl, type DemandRow, type Game } from "../model";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Art, Eur, Figure, Kv, Plate, Zone } from "../ui/parts";
import { Pill } from "../ui/Pill";
import { listedGames, type ScreenProps } from "./types";

/** A1: what the app read about this PC, part by part. */
export function ReadPc({ view, go, setupDone }: ScreenProps & { setupDone: boolean }) {
  const { reading, hardware: hw, hardwareRate } = view.pc;
  const parts = [hw?.gpu, hw?.cpu, hw?.ramMb, hw?.upMbps ?? hw?.display];
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
          <Kv label="Memory">
            {hw?.ramMb ? `${Math.round(hw.ramMb / 1024)} GB` : reading ? "…" : "Not found"}
          </Kv>
          {hw?.upMbps ? (
            <Kv label="Connection">
              {hw.upMbps >= 1000
                ? `${Math.round(hw.upMbps / 100) / 10} Gbit`
                : `${Math.round(hw.upMbps)} Mbit`}
            </Kv>
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
            <Pill icon="arrow" onClick={() => go("games")} disabled={reading}>
              {view.games.offered ? "Choose games" : "See games"}
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

/** Ranked by demand where Swiff reports it; otherwise the installed games by name. */
function rows(installed: Game[], demand: DemandRow[] | null): Row[] {
  if (!demand) return installed.map((game) => ({ game, rank: null, demand: null, installed: true }));
  const ranked: Row[] = demand.map((d, i) => ({
    game: { appid: d.appid, name: d.name },
    rank: i + 1,
    demand: d,
    installed: installed.some((g) => g.appid === d.appid),
  }));
  const rest = installed
    .filter((g) => !demand.some((d) => d.appid === g.appid))
    .map((game) => ({ game, rank: null, demand: null, installed: true }));
  return [...ranked, ...rest];
}

/**
 * A2: which installed games players can stream here, with demand where Swiff
 * reports it. Read-only until the games are read.
 */
export function Games({ view, actions, go, finishSetup }: ScreenProps & { finishSetup: () => void }) {
  const { installed, offered, demand } = view.games;
  const toggle = offered ? actions.toggleOffer : null;
  const top = demand?.[0]?.looking ?? 0;
  const list = rows(installed, demand);

  return (
    <main className="step">
      <section className="hz games">
        <div className="cp">
          <p className="mono ctx">{demand ? "Demand, last hour" : "Installed on this PC"}</p>
          <h1>{toggle ? "Choose the games you offer" : "Your installed games"}</h1>
          <p className="ln">
            Players can stream a game only if they own it too.
            {demand ? " Offer the games you have; install the popular ones you don't." : ""}
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
                    <span className="mono">{d.looking} looking</span>
                  </span>
                ) : null}
              </>
            );
            if (!has) {
              return (
                <div key={game.appid} className="gtile missing">
                  {body}
                  <span className="gact">
                    <a className="inst" href={installUrl(game.appid)} target="_blank" rel="noreferrer">
                      <Glyph name="download" size={15} />
                      Install on Steam
                    </a>
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
            : "No installed Steam games were found on this PC. Games you install in Steam show up here when they finish."}
        </p>
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
