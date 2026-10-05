import type { ReactNode } from "react";
import { clock, count, euros, shortGpu } from "../format";
import { claimEnd, levelProgress, steamReady, type HostView, type Standing, type Step } from "../model";
import { rentalStatus } from "../rental";
import { DemoTag } from "./parts";

type RailStep = { id: Exclude<Step, "settings">; title: string };

const STEPS: RailStep[] = [
  { id: "pc", title: "This PC" },
  { id: "steam", title: "Steam" },
  { id: "games", title: "Games" },
  { id: "rental", title: "Rental mode" },
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

/** Where Steam stands on this PC, in a few words. */
function steamLine({ steam }: HostView): string {
  const { status, installs } = steam;
  if (!status) return "Looking for Steam";
  if (!status.installed) return "Not installed";
  if (!steamReady(steam)) return "Sign in to Steam";
  return installs.length ? `Installing ${count(installs.length, "game", "games")}` : "Signed in";
}

/** Where rental mode stands on this PC, in a few words. */
function rentalLine({ rental }: HostView): string {
  const { read, reading, target } = rental;
  if (!read) return reading ? "Checking this PC" : "Not read";
  if (read.installed) return "Installed";
  const { bios, fixes } = rentalStatus(read, target);
  if (bios.length) return bios.length === 1 ? "One change in the BIOS" : `${bios.length} changes in the BIOS`;
  if (fixes.length) return "Not ready";
  return "Ready to install";
}

/** One line under each step: what it has, or what it is doing now. */
function stepLine(id: RailStep["id"], view: HostView, setupDone: boolean): string {
  const { pc, games } = view;
  switch (id) {
    case "steam":
      return steamLine(view);
    case "rental":
      return rentalLine(view);
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
 * The rail: the six PC steps with where each stands, the owner's standing at
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
  const live = STEPS.findIndex((s) => s.id === "live");
  const at = step === "settings" ? live : STEPS.findIndex((s) => s.id === step);
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
          // Rental mode is optional: it is done once installed, not by being passed.
          const passed =
            s.id === "rental" ? Boolean(view.rental.read?.installed) : i < at || (setupDone && i < live);
          const state = i === at ? "now" : passed ? "done" : "next";
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
