// A3: choose until when players can claim this PC, then hold to go live.

import { clock, count, HOUR, shortGpu } from "../format";
import { connectionReady, nextAt, untilChoices, untilSentence } from "../model";
import { Notice } from "../ui/Notice";
import { Eur, Figure, Kv, Plate, Thumbs, Zone } from "../ui/parts";
import { Reticle } from "../ui/Reticle";
import type { Crew } from "../report";
import { listedGames, tonight, type ScreenProps } from "./types";

/** Four plain choices and an exact time. */
export function UntilPicker({
  now,
  value,
  onChange,
}: {
  now: number;
  value: number | null;
  onChange: (until: number | null) => void;
}) {
  const choices = untilChoices(now);
  const custom = value !== null && !choices.some((c) => c.at === value);
  return (
    <>
      <div className="until" role="radiogroup" aria-label="Share until">
        {choices.map((c) => (
          <button
            key={c.time}
            type="button"
            role="radio"
            aria-checked={c.at === value}
            className="ut"
            onClick={() => onChange(c.at)}
          >
            <b>{c.time}</b>
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <label className="ucustom">
        <span className="mono">Other time</span>
        <input
          type="time"
          value={custom ? clock(value!) : ""}
          onChange={(event) => {
            const at = nextAt(event.target.value, now);
            if (at !== null) onChange(at);
          }}
        />
      </label>
    </>
  );
}

/** "mika_r's crew", "your crew", or "your friend's crew" when the platform has no name for it. */
export function crewName({ name, own }: Crew["crews"][number]): string {
  return own ? "your crew" : name ? `${name}'s crew` : "your friend's crew";
}

/**
 * Who can play on this PC: only the crews its owner joined from a friend's
 * invite link, or anyone on Swiff. Shown once the platform has said this PC's
 * owner is in a crew; the platform holds the choice.
 */
export function CrewPicker({ crew, onChange }: { crew: Crew | null; onChange: (only: boolean) => void }) {
  if (!crew?.crews.length) return null;
  const crews = crew.crews.map(crewName);
  const named = crews.length === 1 ? crews[0]! : `${crews.slice(0, -1).join(", ")} and ${crews.at(-1)}`;
  const size = crew.crews.reduce((n, c) => n + c.size - 1, 0);
  const choices = [
    { only: true, b: "Crew only", span: `${count(size, "player", "players")} you know` },
    { only: false, b: "Anyone", span: "Every player on Swiff" },
  ];
  return (
    <>
      <p className="mono label" id="crew-label">
        Who can play
      </p>
      <div className="until crew-pick" role="radiogroup" aria-labelledby="crew-label">
        {choices.map((c) => (
          <button
            key={c.b}
            type="button"
            role="radio"
            aria-checked={crew.only === c.only}
            className="ut"
            onClick={() => onChange(c.only)}
          >
            <b>{c.b}</b>
            <span>{c.span}</span>
          </button>
        ))}
      </div>
      <p className="note6">
        {crew.only ? `Only ${named} can claim this PC.` : `Anyone on Swiff can claim this PC, ${named} too.`}
      </p>
    </>
  );
}

export function GoLive({ view, actions, go }: ScreenProps) {
  const { machine, rate, plan, live, connection, now } = view;
  const ready = connectionReady(connection);
  const games = listedGames(view);
  const note = live.kind === "off" ? live.note : null;
  const gpu = view.pc.hardware?.gpu;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">
            {machine}
            {rate ? (
              <>
                , <Eur n={rate.total} /> an hour
              </>
            ) : null}
          </p>
          <h1>Ready to share</h1>
          <p className="ln">Choose until when players can claim {machine}, then hold the button.</p>
          <div className="ctl">
            <p className="mono label" aria-hidden="true">
              Share until
            </p>
            <UntilPicker now={now} value={plan} onChange={actions.plan} />
            <p className="note6">{untilSentence(machine, plan)}</p>
            <CrewPicker crew={view.crew} onChange={actions.setCrewOnly} />
            {!ready ? (
              <p className="note6">
                Add this PC&rsquo;s connection details in{" "}
                <button type="button" className="lnk" onClick={() => go("settings")}>
                  Settings
                </button>{" "}
                first.
              </p>
            ) : null}
            {note ? <Notice icon="clock">{note}</Notice> : null}
            {connection.notice ? <Notice>{connection.notice}</Notice> : null}
          </div>
        </div>
        <Plate className="ret" caption={["Go live", "No account needed yet"]}>
          <Reticle onFire={actions.goLive} disabled={!ready} starting={live.kind === "starting"} />
        </Plate>
      </section>

      <div className={rate ? "sz two wide" : "sz one"}>
        <Zone
          title={
            view.games.offered === null
              ? `${count(games.length, "game", "games")} installed`
              : `Offering ${count(games.length, "game", "games")}`
          }
          action={
            <button type="button" className="lnk" onClick={() => go("games")}>
              {view.games.offered === null ? "See all" : "Edit"}
            </button>
          }
        >
          <Thumbs games={games} />
        </Zone>
        {rate ? (
          <Zone title="Your rate">
            <Figure size="xs" unit="an hour">
              <Eur n={rate.total} />
            </Figure>
            <Kv label={`Hardware${gpu ? `, ${shortGpu(gpu)}` : ""}`}>
              <Eur n={rate.hardware} />
            </Kv>
            <Kv label={`Reliability ${rate.reliability}`}>{Math.round(rate.factor * 100)}%</Kv>
            <Kv label={`Level ${rate.level.name}`}>+{Math.round(rate.level.bonus * 100)}%</Kv>
            {plan !== null ? (
              <p className="soft fine">
                At most <Eur n={(rate.total * Math.max(0, plan - now)) / HOUR} /> {tonight(now)}, if a player
                stays until {clock(plan)}.
              </p>
            ) : null}
          </Zone>
        ) : null}
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
