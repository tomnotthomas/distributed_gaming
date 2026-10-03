// A3: choose until when players can claim this PC, then hold to go live.

import { clock, count, HOUR, shortGpu } from "../format";
import { connectionReady, nextAt, untilChoices, untilSentence } from "../model";
import { Notice } from "../ui/Notice";
import { Eur, Figure, Kv, Plate, Thumbs, Zone } from "../ui/parts";
import { Reticle } from "../ui/Reticle";
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
