import { Backdrop, Button, Hero, HoldButton, Icon, MachineCard, Meter, SplitButton, Tag } from "@swiff/ui";
import { feel, fmtLeft, lasts, meters, minsLeft, reason } from "./derive";
import { gameArt, gameArtFallbacks, gameTrailer } from "./steam";
import type { Swiff } from "./useSwiff";

/** One game, full bleed, with the machines that can run it along the bottom. */
export function GameMenu({ swiff }: { swiff: Swiff }) {
  const { game, machines, picked, session, machinesOpen } = swiff;
  if (!game) return null;

  const live = machines.filter((m) => !m.busy);
  const busy = machines.filter((m) => m.busy);
  const pickedMeters = picked ? meters(picked) : null;

  return (
    <main className="menu">
      <Backdrop
        key={game.id}
        image={gameArt(game)}
        fallback={gameArtFallbacks(game)}
        video={gameTrailer(game)}
        position={game.focus}
        scrims={["pocket", "bottom"]}
      />

      <div className={machinesOpen ? "menu-hero" : "menu-hero menu-hero-folded"}>
        <Hero
          size="xl"
          enter
          title={
            <>
              {game.t1}
              {game.t2 ? (
                <>
                  <br />
                  {game.t2}
                </>
              ) : null}
            </>
          }
          meta={game.personal}
          body={game.promise}
        />

        <div className="menu-launch">
          <SplitButton
            expanded={machinesOpen}
            onToggle={() => swiff.setMachinesOpen(!machinesOpen)}
            toggleLabel="Choose a different machine"
          >
            <HoldButton size="xl" icon={<Icon name="play" />} disabled={!picked} onFire={swiff.launch}>
              Launch
            </HoldButton>
          </SplitButton>

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
            <Button variant="link" onClick={() => swiff.setMachinesOpen(true)}>
              Change machine
            </Button>
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
