// A3: go live. In rental mode the PC restarts into Swiff OS; development builds
// can still share this Windows desktop until a chosen time.

import { useState } from "react";
import { httpOrigin } from "@swiff/rtc";
import { clock, count, HOUR, shortGpu } from "../format";
import { connectionReady, nextAt, untilChoices, untilSentence } from "../model";
import { Notice } from "../ui/Notice";
import { Eur, Figure, Kv, Plate, Thumbs, Zone } from "../ui/parts";
import { WINDOWS_SHARE } from "../devShare";
import { failureOf, rentalScreen } from "../rental";
import { Pill } from "../ui/Pill";
import { Reticle } from "../ui/Reticle";
import { Sent } from "./Rental";
import type { Crew } from "../report";
import { toSocketUrl } from "../settings";
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

/** Whether to ask who can play: once the platform says this PC's owner is in a crew, or while it is crew-only. */
export const asksWhoCanPlay = (crew: Crew | null): crew is Crew =>
  Boolean(crew && (crew.crews.length || crew.only));

/** The web app's address on the connection's server, where the owner's invite link is; null when it cannot be read. */
export function siteOf(url: string): string | null {
  try {
    return httpOrigin(toSocketUrl(url));
  } catch {
    return null;
  }
}

/**
 * Who can play on this PC: only the crews its owner joined from a friend's
 * invite link, or anyone on Swiff. Shown once the platform has said this PC's
 * owner is in a crew, and while it is crew-only, so a crew-only PC nobody else
 * may play on can still be opened; the platform holds the choice. `site` is
 * where the owner finds their invite link.
 */
export function CrewPicker({
  crew,
  site,
  onChange,
}: {
  crew: Crew | null;
  site: string | null;
  onChange: (only: boolean) => void;
}) {
  const [inviting, setInviting] = useState(false);
  if (!asksWhoCanPlay(crew)) return null;
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
      {crew.only && !crew.crews.length ? (
        <>
          <p className="note6">
            Nobody in your crew can play on this PC right now.{" "}
            <button type="button" className="lnk" onClick={() => onChange(false)}>
              Open to everyone
            </button>{" "}
            or{" "}
            <button type="button" className="lnk" onClick={() => setInviting(true)}>
              Invite a friend
            </button>
            .
          </p>
          {inviting ? (
            <p className="note6">
              Open <b>{site ?? "Swiff"}</b> in your browser, sign in with Steam, and send your link from Ask
              your PC friend on your profile.
            </p>
          ) : null}
        </>
      ) : (
        <p className="note6">
          {crew.only
            ? `Only ${named} can claim this PC.`
            : `Anyone on Swiff can claim this PC, ${named} too.`}
        </p>
      )}
    </>
  );
}

/**
 * Go live, in rental mode: the PC restarts into Swiff OS, where players book
 * it. Holding the button is the owner's OK: the restart follows by itself.
 * Who can play is asked here, as the platform holds it for Swiff OS's offers.
 */
export function GoLive(props: ScreenProps) {
  const { view, actions } = props;
  if (WINDOWS_SHARE) return <GoLiveWindows {...props} />;
  // Reachable only once rental mode is ready (stepLocked): the shell shows rental mode until then.
  const setup = view.rental;
  const s = rentalScreen(setup);
  const busy = s.kind === "elevating" || s.kind === "running" || s.kind === "restarting";
  const status =
    s.kind === "elevating"
      ? "Windows asks for permission. Click Yes. No prompt? Look for a flashing shield on the taskbar."
      : s.kind === "running"
        ? "Getting the restart ready."
        : s.kind === "restarting" || s.kind === "restart"
          ? "Restarting into Swiff OS."
          : null;
  const failed = s.kind === "failed" ? failureOf(setup, s) : null;
  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{view.machine}</p>
          <h1>{failed ? failed.title : "Ready to go live"}</h1>
          <p className="ln">
            {failed
              ? failed.why
              : "Hold the button. The PC restarts into Swiff OS, and players can book it. For now its next restart is Windows again."}
          </p>
          {!status && !failed && asksWhoCanPlay(view.crew) ? (
            <div className="ctl">
              <CrewPicker
                crew={view.crew}
                site={siteOf(view.connection.url)}
                onChange={actions.setCrewOnly}
              />
              {view.crewNote ? <Notice>{view.crewNote}</Notice> : null}
            </div>
          ) : null}
          {status ? (
            <p className="mstatus mlive">
              <i className="mpulse" aria-hidden="true" />
              {status}
            </p>
          ) : null}
          {failed && setup.run.reportedAt !== null ? <Sent at={setup.run.reportedAt} /> : null}
          {failed ? (
            <div className="acts">
              {/* The failure's own next step, as on the rental screen. */}
              <Pill
                icon={failed.action === "send" ? "arrow" : "refresh"}
                onClick={() => {
                  if (failed.action === "send") return actions.reportRental();
                  if (failed.action === "restart") return actions.restartRental();
                  if (failed.action === "check") {
                    actions.closeRentalPreview();
                    return actions.checkRental();
                  }
                  actions.retryRental();
                }}
              >
                {failed.label}
              </Pill>
            </div>
          ) : null}
        </div>
        <Plate className="ret" caption={["Go live", busy ? "Starting" : "Hold to start"]}>
          <Reticle onFire={actions.goLiveRental} starting={busy} />
        </Plate>
      </section>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** Development builds only: going live by sharing this Windows desktop. */
function GoLiveWindows({ view, actions, go }: ScreenProps) {
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
          <h1>Ready to go live</h1>
          <p className="ln">Pick an end time, then hold the button.</p>
          <div className="ctl">
            <p className="mono label" aria-hidden="true">
              Live until
            </p>
            <UntilPicker now={now} value={plan} onChange={actions.plan} />
            <p className="note6">{untilSentence(machine, plan)}</p>
            <CrewPicker crew={view.crew} site={siteOf(connection.url)} onChange={actions.setCrewOnly} />
            {!ready ? (
              <p className="note6">
                Add your connection details in{" "}
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
        <Plate className="ret" caption={["Go live", "Hold to start"]}>
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
                Up to <Eur n={(rate.total * Math.max(0, plan - now)) / HOUR} /> {tonight(now)} if players stay
                until {clock(plan)}.
              </p>
            ) : null}
          </Zone>
        ) : null}
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
