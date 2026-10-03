import { Backdrop } from "@swiff/ui";
import type { Machine } from "./data";
import { feel, fmtLeft, meters, minsLeft } from "./derive";
import { LensDial } from "./instruments";
import { Reticle } from "./Reticle";
import { SignInWithSteam } from "./SignIn";
import { gameArt, gameArtFallbacks } from "./steam";
import type { Swiff } from "./useSwiff";

/** "Stunning, instant": the feel of a machine in two words, for the reading strip. */
function feelShort(machine: Machine, picture: number): string {
  const look = picture >= 4 ? "Stunning" : picture === 3 ? "Sharp" : "Good";
  const response = machine.ping < 15 ? "instant" : machine.ping < 30 ? "quick" : "slight delay";
  return `${look}, ${response}`;
}

const untilShort = (machine: Machine) => (machine.until === "late" ? "All night" : machine.until);

/** "1 machine from 1 player": who is behind the machines listed, where that is known (the demo). */
function ledgerCount(live: Machine[]): string {
  const machines = `${live.length} ${live.length === 1 ? "machine" : "machines"}`;
  // Players behind the machines listed below, not the busy ones left out of it.
  // The server never says who owns a real host, so it counts machines alone.
  const owners = new Set(live.map((m) => m.owner).filter(Boolean)).size;
  return owners ? `${machines} from ${owners} ${owners === 1 ? "player" : "players"}` : machines;
}

/**
 * One game: its key art under a grey veil with the lens left clear, what the
 * chosen machine will feel like, and the ranked machines ("the Ledger") with
 * the Reticle that launches on the chosen one. Signed out there are no
 * machines to list: which can play it is shown only once you sign in.
 */
export function GameMenu({ swiff }: { swiff: Swiff }) {
  const { game, machines, picked, clock, reason: why } = swiff;
  if (!game) return null;

  const live = machines.filter((m) => !m.busy);
  const busy = machines.filter((m) => m.busy);
  const pickedMeters = picked ? meters(picked, game) : null;

  return (
    <main className="menu">
      <div className="menu-art">
        <Backdrop
          key={game.id}
          className="menu-photo"
          image={gameArt(game)}
          fallback={gameArtFallbacks(game)}
          position={game.focus}
          drift
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
            {!swiff.seesAvailability
              ? "Machines"
              : swiff.machinesLoading
                ? "Finding machines…"
                : ledgerCount(live)}
          </span>
          <span>Ranked</span>
        </div>

        <div className="ledger">
          {!swiff.seesAvailability ? (
            <p className="ledger-busy mono">Sign in to see which machines can play it, and how well.</p>
          ) : !swiff.machinesLoading && !machines.length ? (
            <p className="ledger-busy mono">No machine can play it right now.</p>
          ) : null}
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
                    {[machine.self ? "your machine" : (machine.owner ?? machine.cpu), machine.gpu]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                  <span className="ledger-meta">
                    <span className={index === 0 && why ? "ledger-tag best" : "ledger-tag"}>{tag}</span>
                    <span>{fmtLeft(minsLeft(machine, clock))} left</span>
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

        {swiff.signedIn ? (
          <div className="ledger-launch">
            <Reticle
              onFire={swiff.launch}
              disabled={!picked}
              launching={swiff.phase !== "idle"}
              label={picked ? `Hold to launch on ${picked.name}` : "Pick a machine to launch"}
            />
          </div>
        ) : (
          // Signed out there is nothing to launch: playing books a stranger's
          // PC, and the server books only for a signed-in renter.
          <div className="ledger-launch ledger-signin">
            <p>Sign in to play. We stream the games you own on Steam, and the free ones.</p>
            <SignInWithSteam />
          </div>
        )}

        <p className="ledger-foot mono" hidden={!live.length}>
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
