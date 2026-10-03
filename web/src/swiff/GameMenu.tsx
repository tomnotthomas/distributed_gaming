import { Backdrop, Button } from "@swiff/ui";
import type { Machine } from "./data";
import { feel, fmtLeft, leftAt, meters } from "./derive";
import { LensDial } from "./instruments";
import { Reticle } from "./Reticle";
import { SignInWithSteam } from "./SignIn";
import type { Refusal } from "./booking";
import { gameArt, gameArtFallbacks } from "./steam";
import type { Swiff } from "./useSwiff";

/** "Stunning, instant": the feel of a machine in two words, for the reading strip. */
function feelShort(machine: Machine, picture: number): string {
  const look = picture >= 4 ? "Stunning" : picture === 3 ? "Sharp" : "Good";
  const response = machine.ping < 15 ? "instant" : machine.ping < 30 ? "quick" : "slight delay";
  return `${look}, ${response}`;
}

const untilShort = (machine: Machine) => (machine.until === "late" ? "All night" : machine.until);

/** How a machine's round trip was arrived at, for its tooltip. */
const PATH_NOTE = {
  direct: "Measured straight to this PC",
  relay: "Measured straight to this PC, through a relay",
  estimate: "Estimated through Swiff",
} as const;

/** How many of the best machines the page measures straight (PROBED_PER_GAME on the server). */
const PROBED = 3;

/** "1 machine from 1 player": who is behind the machines listed, where that is known (the demo). */
function ledgerCount(live: Machine[]): string {
  const machines = `${live.length} ${live.length === 1 ? "machine" : "machines"}`;
  // Players behind the machines listed below, not the busy ones left out of it.
  // The server never says who owns a real host, so it counts machines alone.
  const owners = new Set(live.map((m) => m.owner).filter(Boolean)).size;
  return owners ? `${machines} from ${owners} ${owners === 1 ? "player" : "players"}` : machines;
}

/** What the page says when the server refuses a game the renter may not play (server/src/licence.ts). */
export const REFUSAL_COPY: Record<Refusal, string> = {
  "not-owned":
    "You don't own this game on Steam. You play with your own Steam licence, so only games in your Steam library and free-to-play games can start.",
  "library-unreadable":
    "We can't see your Steam library, so only free-to-play games can start. In Steam, set Profile → Privacy → Game details to Public, then try again.",
};

/**
 * What became of the renter's booking, under the Reticle: waiting in the
 * queue, a picked machine taken first with the next best to launch on instead,
 * a game the server refused, or a call that failed. With no machine free on
 * the server's list and no booking, the way into the queue.
 */
function BookingNote({ swiff, free }: { swiff: Swiff; free: number }) {
  const { booking, taken, bookingFailed, refusal, phase } = swiff;
  const waiting =
    booking &&
    (booking.status === "queued" || (booking.status === "matched" && !bookingFailed)) &&
    phase === "idle";
  if (waiting) {
    return (
      <div className="ledger-note" role="status">
        <p>
          {booking.status === "matched"
            ? "A machine is free for you. Starting…"
            : "You're in the queue. Keep this page open: we start the moment a machine is free."}
        </p>
        <Button onClick={swiff.leaveQueue}>Leave the queue</Button>
      </div>
    );
  }
  if (taken) {
    const next = taken.nextBest;
    return (
      <div className="ledger-note" role="status">
        <p>
          {next
            ? `That machine was just taken. Next best: ${next.name ?? next.gpu}, ${Math.round(next.latency.rttMs)} ms away.`
            : "That machine was just taken, and no other is free. Queue, and we start the moment one is."}
        </p>
        {next ? (
          <Button onClick={swiff.launchNextBest}>Play on {next.name ?? next.gpu}</Button>
        ) : (
          <Button onClick={swiff.joinQueue}>Join the queue</Button>
        )}
      </div>
    );
  }
  if (bookingFailed) {
    return (
      <p className="ledger-note" role="alert">
        {refusal ? REFUSAL_COPY[refusal] : "That didn't go through. Try again."}
      </p>
    );
  }
  const over = !booking || booking.status === "ended" || booking.status === "expired";
  // Only once the server's list is in: the demo's invented machines have no queue.
  if (!free && over && phase === "idle" && !swiff.machinesLoading && !swiff.demo) {
    return (
      <div className="ledger-note">
        <p>Nothing free right now. Queue, and we start the moment a machine is.</p>
        <Button onClick={swiff.joinQueue}>Join the queue</Button>
      </div>
    );
  }
  return null;
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
              <dd title={PATH_NOTE[picked.path ?? "estimate"]}>
                {swiff.measuring && !picked.path ? "Measuring…" : `${picked.ping} ms`}
              </dd>
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
                : swiff.measuring
                  ? "Measuring latency…"
                  : ledgerCount(live)}
          </span>
          <span>Ranked</span>
        </div>

        <div className="ledger" aria-busy={swiff.machinesLoading || swiff.measuring}>
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
                <span
                  className={
                    swiff.measuring && index < PROBED && !machine.path ? "ledger-ms measuring" : "ledger-ms"
                  }
                  title={PATH_NOTE[machine.path ?? "estimate"]}
                >
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
                    <span>{fmtLeft(leftAt(machine, clock))} left</span>
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
            <BookingNote swiff={swiff} free={live.length} />
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
