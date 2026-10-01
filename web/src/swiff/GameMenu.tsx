import { Backdrop } from "@swiff/ui";
import type { Machine } from "./data";
import { feel, fmtLeft, meters, minsLeft, reason } from "./derive";
import { LensDial } from "./instruments";
import { Reticle } from "./Reticle";
import { gameArt, gameArtFallbacks, gameTrailer } from "./steam";
import type { Swiff } from "./useSwiff";

/** "Stunning, instant": the feel of a machine in two words, for the reading strip. */
function feelShort(machine: Machine, picture: number): string {
  const look = picture >= 4 ? "Stunning" : picture === 3 ? "Sharp" : "Good";
  const response = machine.ping < 15 ? "instant" : machine.ping < 30 ? "quick" : "slight delay";
  return `${look}, ${response}`;
}

const untilShort = (machine: Machine) => (machine.until === "late" ? "All night" : machine.until);

/**
 * One game: its key art under a grey veil with the lens left clear, what the
 * chosen machine will feel like, and the ranked machines ("the Ledger") with
 * the Reticle that launches on the chosen one.
 */
export function GameMenu({ swiff }: { swiff: Swiff }) {
  const { game, machines, picked, pool, session, quality, devices } = swiff;
  if (!game) return null;

  const live = machines.filter((m) => !m.busy);
  const busy = machines.filter((m) => m.busy);
  // Players behind the machines listed below, not the busy ones left out of it.
  const owners = new Set(live.map((m) => m.owner)).size;
  const why = reason(game, pool, session, { quality, devices });
  const pickedMeters = picked ? meters(picked, game) : null;

  return (
    <main className="menu">
      <div className="menu-art">
        <Backdrop
          key={game.id}
          className="menu-photo"
          image={gameArt(game)}
          fallback={gameArtFallbacks(game)}
          video={gameTrailer(game)}
          position={game.focus}
        />
        <div className="menu-veil" />
        <div className="menu-shade" />
        <div className="menu-cross" aria-hidden="true" />
        <LensDial />

        <div className="menu-copy">
          <div className="mono menu-kicker">{game.personal}</div>
          <h1 className="menu-title">{game.title}</h1>
          <p className="menu-line">{game.promise}</p>
        </div>

        {picked && pickedMeters ? (
          <dl className="menu-reads mono" title={feel(picked, game).tech}>
            <div>
              <dt>Picture</dt>
              <dd>{feel(picked, game).tech.split(" · ")[0]}</dd>
            </div>
            <div>
              <dt>Response</dt>
              <dd>{picked.ping} ms</dd>
            </div>
            <div>
              <dt>Free until</dt>
              <dd>{untilShort(picked)}</dd>
            </div>
            <div>
              <dt>Feel</dt>
              <dd>{feelShort(picked, pickedMeters.picture)}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <aside className="ledger-panel" aria-label="Machines">
        <div className="ledger-head mono">
          <span>
            {live.length} {live.length === 1 ? "machine" : "machines"} from {owners}{" "}
            {owners === 1 ? "player" : "players"}
          </span>
          <span>Ranked</span>
        </div>

        <div className="ledger">
          {live.map((machine, index) => {
            const chosen = picked?.id === machine.id;
            const tag = index === 0 && why ? why : machine.quality;
            return (
              <button
                key={machine.id}
                type="button"
                className={chosen ? "ledger-row on" : "ledger-row"}
                aria-pressed={chosen}
                onClick={() => swiff.setMachineId(machine.id)}
              >
                <span className="ledger-ms">
                  {machine.ping}
                  <small>ms</small>
                </span>
                <span className="ledger-body">
                  <b>{machine.name}</b>
                  <span className="ledger-who">
                    {machine.self ? "your machine" : machine.owner}, {machine.gpu}
                  </span>
                  <span className="ledger-meta">
                    <span className={index === 0 && why ? "ledger-tag best" : "ledger-tag"}>{tag}</span>
                    <span>{fmtLeft(minsLeft(machine))} left</span>
                  </span>
                </span>
              </button>
            );
          })}
          {busy.length ? (
            <p className="ledger-busy mono">
              +{busy.length} back at {busy[0]!.back ?? "later"}
            </p>
          ) : null}
        </div>

        <div className="ledger-launch">
          <Reticle
            onFire={swiff.launch}
            disabled={!picked}
            launching={swiff.phase !== "idle"}
            label={picked ? `Hold to launch on ${picked.name}` : "Pick a machine to launch"}
          />
        </div>

        <p className="ledger-foot mono">
          {picked
            ? `${picked.name}, ${picked.until === "late" ? "free all night" : `free until ${picked.until}`}`
            : "Pick a machine above"}
          <br />
          Use ← → to move
        </p>
      </aside>
    </main>
  );
}
