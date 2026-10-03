import type { ReactNode } from "react";
import { clock, count, euros, shortGpu } from "../format";
import { claimEnd, levelProgress, type HostView, type Standing, type Step } from "../model";
import { DemoTag } from "./parts";

type RailStep = { id: Exclude<Step, "settings">; title: string };

const STEPS: RailStep[] = [
  { id: "pc", title: "This PC" },
  { id: "games", title: "Games" },
  { id: "live", title: "Go live" },
  { id: "paid", title: "Get paid" },
];

function liveLine(live: HostView["live"], setupDone: boolean): string {
  switch (live.kind) {
    case "off":
      return setupDone ? "Not sharing" : "Hold to start";
    case "starting":
      return "Starting";
    case "waiting":
      return `Live since ${clock(live.since)}`;
    case "session":
      return `${live.atPc ? "In use" : "Streaming"} until ${clock(claimEnd(live.claim))}`;
    case "ending":
      return "Ending early";
    case "paused":
      return `Paused at ${clock(live.at)}`;
    case "offline":
      return `Offline since ${clock(live.since)}`;
  }
}

/** One line under each step: what it has, or what it is doing now. */
function stepLine(id: RailStep["id"], view: HostView, setupDone: boolean): string {
  const { pc, games } = view;
  switch (id) {
    case "pc": {
      if (pc.reading) return "Reading hardware";
      const gpu = pc.hardware?.gpu ? shortGpu(pc.hardware.gpu) : "Hardware read";
      return pc.hardwareRate === null ? gpu : `${gpu}, hardware rate €${euros(pc.hardwareRate)}`;
    }
    case "games": {
      const installed = games.installed.length;
      const { offered: chosen } = games;
      if (chosen === null)
        return pc.reading ? "Reading Steam library" : `${count(installed, "game", "games")} installed`;
      if (!setupDone) return "Choose what players can stream";
      const offered = games.installed.filter((g) => chosen.includes(g.appid)).length;
      return `${offered} of ${installed} games offered`;
    }
    case "live":
      return liveLine(view.live, setupDone);
    case "paid":
      if (!view.earnings) return "Payouts are not open yet";
      return view.payoutSaved ? `Payout ${view.earnings.nextPayout}` : "Paid on the 1st";
  }
}

/** The rail's foot card: seven-day reliability as a ring, and the level's progress. */
export function StandingCard({ standing }: { standing: Standing }) {
  const { level, share, line } = levelProgress(standing.reliableHours);
  const drop = standing.was !== null ? standing.was - standing.reliability : 0;
  return (
    <div className="stand" aria-label="Your standing">
      <div className="sth">
        <svg className="relr" viewBox="0 0 48 48" aria-hidden="true" fill="none">
          <circle cx={24} cy={24} r={21} stroke="currentColor" opacity={0.18} strokeWidth={2.5} />
          <circle
            className="relarc"
            cx={24}
            cy={24}
            r={21}
            strokeWidth={2.5}
            pathLength={100}
            strokeDasharray={`${standing.reliability} 100`}
            transform="rotate(-90 24 24)"
          />
        </svg>
        <div>
          <b>
            {standing.reliability}
            {drop > 0 ? <em>↓{drop}</em> : null}
          </b>
          <span className="mono">Reliability, 7 days</span>
        </div>
      </div>
      <div className="lvl">
        <div className="lvh">
          <span className="mono">Level</span>
          <b>{level.name}</b>
        </div>
        <span className="lvb">
          <i style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        <small>{line}</small>
      </div>
    </div>
  );
}

/**
 * The rail: the four PC steps with where each stands, the owner's standing at
 * its foot from the second step on, and Settings.
 */
export function Rail({
  view,
  step,
  setupDone,
  onStep,
  foot,
}: {
  view: HostView;
  step: Step;
  setupDone: boolean;
  onStep: (step: Step) => void;
  /** The demo's screen picker, in demo mode. */
  foot?: ReactNode;
}) {
  const at = step === "settings" ? 2 : STEPS.findIndex((s) => s.id === step);
  return (
    <nav className="path" aria-label="Steps">
      <div className="pwm">
        <span className="wm">SWIFF</span>
        <span className="mono">{view.machine}</span>
      </div>
      {view.demo ? (
        <div className="demo-row">
          <DemoTag />
        </div>
      ) : null}
      <ol>
        {STEPS.map((s, i) => {
          const state = i === at ? "now" : i < at || (setupDone && i < 2) ? "done" : "next";
          return (
            <li key={s.id} className={`pt ${state}`}>
              <button
                type="button"
                aria-current={i === at && step !== "settings" ? "step" : undefined}
                onClick={() => onStep(s.id)}
              >
                <span className="pd" />
                <span className="ptx">
                  <b>{s.title}</b>
                  <span>{stepLine(s.id, view, setupDone)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {view.standing && step !== "pc" ? <StandingCard standing={view.standing} /> : null}
      <div className="pfoot">
        <button
          type="button"
          className="lnk"
          aria-current={step === "settings" ? "page" : undefined}
          onClick={() => onStep("settings")}
        >
          Settings
        </button>
        {foot}
      </div>
    </nav>
  );
}
