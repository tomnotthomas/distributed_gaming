import { HoldButton, MachineCard, Meter, Tag, Trailer } from "@swiff/ui";
import { trailerUrl } from "./data";
import { feel, fmtLeft, lasts, meters, minsLeft, reason } from "./derive";
import { gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

const PLAY_ICON = (
  <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <path d="M232.4 114.5 88.3 26.4a16 16 0 0 0-16.2-.3A15.9 15.9 0 0 0 64 40v176a15.9 15.9 0 0 0 8.1 13.9 16 16 0 0 0 16.2-.3l144.1-88.1a15.9 15.9 0 0 0 0-27Z" />
  </svg>
);

/** One game, full bleed, with the machines that can run it along the bottom. */
export function GameMenu({ swiff }: { swiff: Swiff }) {
  const { game, machines, picked, session, motion, machinesOpen } = swiff;
  if (!game) return null;

  const live = machines.filter((m) => !m.busy);
  const busy = machines.filter((m) => m.busy);
  const pickedMeters = picked ? meters(picked) : null;

  return (
    <main className="menu">
      <div className="menu-art">
        {motion && game.video ? (
          <Trailer
            key={game.id}
            className="menu-video"
            src={trailerUrl(game.video)}
            poster={gameArt(game)}
            style={{ objectPosition: game.focus }}
          />
        ) : (
          <div
            className="menu-still"
            style={{ backgroundImage: `url(${gameArt(game)})`, backgroundPosition: game.focus }}
          />
        )}
        <div className="menu-pocket" />
        <div className="menu-fade" />
      </div>

      <div className={machinesOpen ? "menu-hero" : "menu-hero menu-hero-folded"}>
        <h1 className="menu-title">
          {game.t1}
          {game.t2 ? (
            <>
              <br />
              {game.t2}
            </>
          ) : null}
        </h1>
        <p className="menu-personal">{game.personal}</p>
        <p className="menu-promise">{game.promise}</p>

        <div className="menu-launch">
          <div className="menu-launch-row">
            <HoldButton icon={PLAY_ICON} disabled={!picked} onFire={swiff.launch}>
              Launch
            </HoldButton>
            <button
              type="button"
              className="btn btn-primary menu-launch-more"
              onClick={() => swiff.setMachinesOpen(!machinesOpen)}
              aria-label="Choose a different machine"
              aria-expanded={machinesOpen}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 256 256"
                fill="currentColor"
                style={{ transform: machinesOpen ? "none" : "rotate(180deg)" }}
                aria-hidden="true"
              >
                <path d="M213.7 101.7l-80 80a8 8 0 0 1-11.4 0l-80-80a8 8 0 0 1 11.4-11.4L128 164.7l74.3-74.4a8 8 0 0 1 11.4 11.4Z" />
              </svg>
            </button>
          </div>

          <div className="menu-sub" title={picked ? feel(picked).tech : undefined}>
            <span className="menu-sub-main">
              {picked ? `${picked.name} · ${picked.ping} ms` : "Pick a machine below"} · hold to launch
            </span>
            {pickedMeters ? (
              <>
                <Meter label="Picture" value={pickedMeters.picture} />
                <Meter label="Response" value={pickedMeters.response} />
                <span className="menu-until">free until {picked!.until}</span>
              </>
            ) : null}
          </div>
          {!machinesOpen ? (
            <button type="button" className="linkbtn" onClick={() => swiff.setMachinesOpen(true)}>
              Change machine
            </button>
          ) : null}
        </div>
      </div>

      {machinesOpen ? (
        <div className="selector">
          <div className="selector-head">
            <span className="selector-count">
              {live.length} {live.length === 1 ? "machine" : "machines"} from{" "}
              {new Set(machines.map((m) => m.owner)).size} players
            </span>
            <span className="selector-hint">← → to move · hold Launch to start</span>
          </div>
          <div className="selector-cards">
            {live.map((machine, index) => (
              <MachineCard
                key={machine.id}
                name={machine.name}
                ping={machine.ping}
                owner={machine.self ? "your machine" : `shared by ${machine.owner}`}
                picture={meters(machine).picture}
                response={meters(machine).response}
                left={`${fmtLeft(minsLeft(machine))} left`}
                leftTone={lasts(machine, session) ? "live" : "time"}
                reason={index === 0 ? reason(machine, machines) : undefined}
                hardware={`${machine.gpu} · ${machine.cpu}`}
                selected={picked?.id === machine.id}
                recommended={index === 0 && live.length > 1}
                onPick={() => swiff.setMachineId(machine.id)}
              />
            ))}
            {busy.length ? (
              <span className="selector-busy">
                <Tag tone="time">
                  +{busy.length} back at {busy[0]!.back ?? "later"}
                </Tag>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
