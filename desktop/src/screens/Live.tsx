// A4 to A9: this PC while it is shared. Waiting for a player, a player
// streaming, the owner sitting down during a session, ending early, paused
// and offline.

import { useState } from "react";
import { clock, count, euros, MINUTE, minutesLeft, mmss, span } from "../format";
import {
  buildRate,
  claimEnd,
  GRACE_MS,
  levelProgress,
  sessionEarned,
  sessionStatus,
  type HostView,
  type Live,
} from "../model";
import { Dial, hourOf } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Art, Eur, Figure, Plate, Thumbs, Zone } from "../ui/parts";
import { HoldPill, Pill } from "../ui/Pill";
import { UntilPicker } from "./GoLive";
import { gamesTitle, listedGames, tonight, type ScreenProps } from "./types";

type Of<K extends Live["kind"]> = ScreenProps & { live: Extract<Live, { kind: K }> };

/** The ruled steps of a session, the first one lit. */
function HowItWorks({ view }: { view: HostView }) {
  const steps = [
    `A player claims ${view.machine}`,
    "Their game shows here",
    ...(view.rate ? [`You earn €${euros(view.rate.total)} an hour`] : []),
    "It is protected until it ends",
  ];
  return (
    <ol className="legend">
      {steps.map((step, i) => (
        <li key={step} className={i === 0 ? "lg st-now" : "lg st-next"}>
          <span className="dotst" />
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/** How many of the two most wanted games this PC offers, said plainly. */
function wantedLine(view: HostView): string | null {
  const { demand, offered } = view.games;
  const top = demand?.slice(0, 2) ?? [];
  if (top.length < 2 || !offered) return null;
  const on = top.filter((d) => offered.includes(d.appid)).length;
  if (on === 2) return `The two games they want most are on ${view.machine}.`;
  if (on === 1) return `One of the two games they want most is on ${view.machine}.`;
  return `Neither of the two games they want most is on ${view.machine}.`;
}

/** A4: live, no player yet. */
export function Waiting({ view, actions, live }: Of<"waiting">) {
  const [editing, setEditing] = useState(false);
  const [until, setUntil] = useState(live.until);
  const { machine, now } = view;
  const near = view.games.near;
  const kicker =
    live.until === null
      ? `Live since ${clock(live.since)}`
      : `Live, ${clock(live.since)} to ${clock(live.until)}`;
  const line = view.demo
    ? `${machine} is visible to players near you.`
    : live.registered
      ? `${machine} is connected to Swiff.`
      : `${machine} is connecting to Swiff.`;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">
            <span className="live" />
            {kicker}
          </p>
          <h1>{live.registered ? "Waiting for a player" : "Connecting to Swiff"}</h1>
          <p className="ln">{line} Your PC stays yours until a player claims it.</p>
          {editing ? (
            <div className="ctl">
              <UntilPicker now={now} value={until} onChange={setUntil} />
              <div className="acts">
                <Pill
                  icon="check"
                  onClick={() => {
                    actions.setUntil(until);
                    setEditing(false);
                  }}
                >
                  Keep sharing {until === null ? "until I stop it" : `until ${clock(until)}`}
                </Pill>
                <button type="button" className="lnk" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="acts">
              <Pill icon="pause" onClick={actions.pause}>
                Pause sharing
              </Pill>
              <button
                type="button"
                className="lnk"
                onClick={() => {
                  setUntil(live.until);
                  setEditing(true);
                }}
              >
                Change end time
              </button>
            </div>
          )}
        </div>
        <Plate
          caption={[
            tonight(now) === "tonight" ? "Tonight" : "Today",
            live.until === null ? "Until you stop" : `${clock(live.since)} to ${clock(live.until)}`,
          ]}
        >
          <Dial
            hours={{ from: hourOf(live.since), to: hourOf(live.until ?? now) }}
            big={live.until === null ? "Open" : span(live.until - now)}
            small={live.until === null ? "until you stop" : `left ${tonight(now)}`}
          />
        </Plate>
      </section>

      <div className={near !== null ? "sz three" : "sz two"}>
        <Zone title={gamesTitle(view)}>
          <Thumbs games={listedGames(view)} columns={2} />
        </Zone>
        {near !== null ? (
          <Zone title="Near you now">
            <Figure size="xs" unit="players looking for a PC">
              {near}
            </Figure>
            <p className="soft">{wantedLine(view)}</p>
          </Zone>
        ) : null}
        <Zone title="How a session works">
          <HowItWorks view={view} />
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** A5: a player's session, with their game on the stage. */
export function Streaming({ view, actions, live }: Of<"session">) {
  const { claim, until } = live;
  const { now, rate, standing } = view;
  const end = claimEnd(claim);
  const played = Math.min(claim.minutes, Math.max(0, Math.floor((now - claim.at) / MINUTE)));
  const earned = sessionEarned(claim, now);
  const toward = standing ? levelProgress(standing.reliableHours) : null;
  const status = sessionStatus(live, view.machine, now);

  return (
    <main className="step streaming">
      <div className="hstage tall">
        <Art appid={claim.appid} position="50% 38%" drift />
        <div className="sfade" />
        <div className="sl">
          <p className="mono">
            <span className="live" />
            {status.line}
          </p>
          <h1 className="gname">{claim.name}</h1>
          {earned !== null ? (
            <Figure unit="this session">
              <Eur n={earned} />
            </Figure>
          ) : null}
          <p className="sline">
            Claimed until {clock(end)} and protected until then.
            {until !== null ? ` New players cannot claim past ${clock(until)}.` : ""}
          </p>
        </div>
        <Plate glass>
          <Dial
            live
            progress={played / claim.minutes}
            big={`${played} min`}
            small={`of ${claim.minutes} claimed`}
          />
        </Plate>
      </div>
      <div className="below4">
        <div className="acts">
          {live.stopNew ? (
            <Pill icon="play" aria-pressed onClick={() => actions.setStopNew(false)}>
              Allow new sessions
            </Pill>
          ) : (
            <Pill icon="block" onClick={() => actions.setStopNew(true)}>
              Stop new sessions
            </Pill>
          )}
        </div>
        <dl className="facts inl">
          <div>
            <dt className="mono">Protected until</dt>
            <dd>{clock(end)}</dd>
          </div>
          {rate ? (
            <div>
              <dt className="mono">Rate</dt>
              <dd>
                <Eur n={rate.total} />
                /h, {rate.level.name}
              </dd>
            </div>
          ) : (
            <div>
              <dt className="mono">Claimed</dt>
              <dd>{claim.minutes} min</dd>
            </div>
          )}
          {toward?.next ? (
            <div>
              <dt className="mono">Toward {toward.next.name}</dt>
              <dd>
                {Math.floor(standing!.reliableHours)} of {toward.next.hours} h
              </dd>
            </div>
          ) : (
            <div>
              <dt className="mono">Player</dt>
              <dd>{status.short}</dd>
            </div>
          )}
        </dl>
      </div>
      {live.stopNew ? (
        <p className="lastline">New sessions are stopped. Sharing pauses when this one ends.</p>
      ) : null}
    </main>
  );
}

/** A6: someone is at the keyboard while a player's session runs. */
export function InUse({ view, actions, live }: Of<"session">) {
  const { claim } = live;
  const { now, machine, standing, earlyEnd } = view;
  const end = claimEnd(claim);
  const left = minutesLeft(end, now);
  const after =
    standing && earlyEnd && view.pc.hardwareRate !== null
      ? buildRate(view.pc.hardwareRate, { ...standing, reliability: earlyEnd.reliability })
      : null;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Keyboard or mouse touched</p>
          <h1>{machine} is in use</h1>
          <p className="ln">
            A player is in a protected session until {clock(end)}. Your desktop comes back the moment it ends.
          </p>
          <div className="acts">
            {live.notify ? (
              <Pill icon="check" disabled>
                Notifying you at {clock(end)}
              </Pill>
            ) : (
              <Pill icon="bell" onClick={actions.notifyAtEnd}>
                Notify me at {clock(end)}
              </Pill>
            )}
          </div>
        </div>
        <Plate tint={claim.appid} caption={["Protected until", clock(end)]}>
          <Dial progress={left / claim.minutes} big={`${left} min`} small="until it's yours" />
        </Plate>
      </section>

      {actions.endEarly && standing && earlyEnd ? (
        <div className="sz three">
          <Zone title="Need it sooner?">
            <p className="soft">Ending early warns the player and gives them 5 minutes to save.</p>
            <div className="acts">
              <HoldPill warn icon="warning" label="Hold to end early" onFire={actions.endEarly}>
                End early
              </HoldPill>
            </div>
          </Zone>
          <Zone title="What it costs">
            <Figure size="xs" cost unit="reliability">
              {standing.reliability} to {earlyEnd.reliability}
            </Figure>
            {view.rate && after ? (
              <p className="soft">
                Rate <Eur n={view.rate.total} /> to <Eur n={after.total} /> an hour for 7 days, and {machine}{" "}
                ranks lower with players.
              </p>
            ) : null}
          </Zone>
          <Zone title="The player keeps">
            <p className="soft">Everything they saved, and no charge after the warning.</p>
          </Zone>
        </div>
      ) : (
        <div className="sz two">
          <Zone title="Playing">
            <p className="soft">
              {claim.name}, claimed for {claim.minutes} minutes from {clock(claim.at)}.
            </p>
          </Zone>
          <Zone title="Need it sooner?">
            <p className="soft">
              This session runs to {clock(end)}. Ending a session early is not available yet.
            </p>
          </Zone>
        </div>
      )}
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** A7: the player has been warned and has 5 minutes to save. */
export function Ending({ view, actions, live }: Of<"ending">) {
  const { now, machine, standing, rate } = view;
  const left = Math.max(0, live.warnedAt + GRACE_MS - now);
  const earned = sessionEarned(live.claim, live.warnedAt);

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Ending early, {clock(live.warnedAt)}</p>
          <h1>Player warned</h1>
          <p className="ln">They have 5 minutes to save. {machine} is yours when the dial runs out.</p>
          {actions.cancelEnd ? (
            <div className="acts">
              <Pill icon="undo" onClick={actions.cancelEnd}>
                Cancel, let them play
              </Pill>
            </div>
          ) : null}
        </div>
        <Plate tint={live.claim.appid} caption={["Grace", "5 minutes"]}>
          <Dial progress={left / GRACE_MS} big={mmss(left)} small="grace for the player" />
        </Plate>
      </section>
      <div className="sz three">
        {standing && rate ? (
          <Zone title="Reliability and rate">
            <Figure size="xs" cost unit={standing.was !== null ? `was ${standing.was}` : undefined}>
              {standing.reliability}
            </Figure>
            <p className="soft">
              <Eur n={rate.total} /> an hour until it recovers over the next 7 days.
            </p>
          </Zone>
        ) : null}
        {earned !== null ? (
          <Zone title="This session">
            <Figure size="xs" unit="paid up to the warning">
              <Eur n={earned} />
            </Figure>
          </Zone>
        ) : null}
        <Zone title="Next time">
          <p className="soft">Choose an earlier end time on Go live. Players can only claim time up to it.</p>
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** A8: nothing can start until the owner resumes. */
export function Paused({ view, actions, live }: Of<"paused">) {
  const { earnings, sessionsToday, now } = view;
  return (
    <main className="step">
      <div className="banner mono">
        <Glyph name="pause" />
        Sharing paused at {clock(live.at)}
      </div>
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{view.machine}</p>
          <h1>Paused</h1>
          <p className="ln">Nobody can start a session until you resume.</p>
          <div className="acts">
            <Pill icon="play" onClick={actions.resume}>
              Resume sharing
            </Pill>
          </div>
        </div>
        <Plate caption={["Session", "Paused"]}>
          <Dial off big="Paused" small="no sessions" />
        </Plate>
      </section>
      <div className="sz two">
        <Zone title={tonight(now) === "tonight" ? "Tonight" : "Today"}>
          {earnings ? (
            <Figure size="xs" unit={count(sessionsToday, "session", "sessions")}>
              <Eur n={earnings.today} />
            </Figure>
          ) : (
            <Figure size="xs" unit={sessionsToday === 1 ? "session" : "sessions"}>
              {sessionsToday}
            </Figure>
          )}
        </Zone>
        <Zone title={gamesTitle(view)}>
          <Thumbs games={listedGames(view)} />
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** A9: the connection to Swiff dropped while waiting; the app keeps retrying. */
export function Offline({ view, actions, live, go }: Of<"offline">) {
  return (
    <main className="step">
      <div className="banner mono">
        <Glyph name="offline" />
        No connection to Swiff since {clock(live.since)}
      </div>
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{view.machine}</p>
          <h1>Offline</h1>
          <p className="ln">
            Nobody can start a session and nothing on your PC is shared. Swiff keeps trying to reconnect.
          </p>
          <div className="acts">
            <Pill icon="refresh" onClick={actions.retry}>
              Try again
            </Pill>
            <button type="button" className="lnk" onClick={() => go("settings")}>
              Connection settings
            </button>
          </div>
        </div>
        <Plate caption={["Connection", "Retrying"]}>
          <Dial off cut big="Offline" small="retrying" />
        </Plate>
      </section>
      <div className="sz two">
        <Zone title="Last contact">
          <Figure size="xs">{live.lastContact !== null ? clock(live.lastContact) : "None yet"}</Figure>
        </Zone>
        <Zone title="If it lasts">
          <p className="soft">Check that this PC is online, then open Connection settings.</p>
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
