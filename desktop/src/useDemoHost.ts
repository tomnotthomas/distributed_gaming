import { useCallback, useEffect, useState } from "react";
import {
  DEMO_CREWS,
  DEMO_DEMAND,
  DEMO_EARLY_END_RELIABILITY,
  DEMO_EARNINGS,
  DEMO_HARDWARE,
  DEMO_HARDWARE_RATE,
  DEMO_INSTALLED,
  DEMO_MACHINE,
  DEMO_NEAR,
  DEMO_OFFERED,
  DEMO_STEAM,
  demoState,
  isRentalCase,
  type DemoScreen,
  type DemoState,
} from "./demo";
import { useDemoRental } from "./demoRental";
import { playingFor, type Crew } from "./report";
import { demoSeatClient } from "./seats";
import { buildRate, GRACE_MS, untilChoices, type Host, type HostView, type Live, type Step } from "./model";

/**
 * The demo's view-model: Nova-01's data, and actions that move between the
 * design's screens the way the real ones would. Nothing here reaches the
 * network, the screen or storage. Time passes on the demo's own clock.
 */
export function useDemoHost(screen: DemoScreen): Host & {
  step: Step;
  setStep(step: Step): void;
  jump(screen: DemoScreen): void;
  setupDone: boolean;
} {
  const [state, setState] = useState<DemoState>(() => demoState(screen));
  const [mountedAt, setMountedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(() => Date.now());
  const [offered, setOffered] = useState(DEMO_OFFERED);
  const [picked, setPicked] = useState<{ at: number | null } | null>(null);
  const [asked, setAsked] = useState<number[]>([]);
  const [crew, setCrew] = useState<Crew>({ only: true, crews: DEMO_CREWS });
  const [seats] = useState(() => demoSeatClient());
  const [shown, setShown] = useState<DemoScreen>(screen);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const now = state.clockAt + (tick - mountedAt);
  const plan = picked ? picked.at : untilChoices(now)[1]!.at;
  const setLive = useCallback((live: Live) => setState((s) => ({ ...s, live })), []);

  // The warned player's grace runs out: the PC is the owner's again, and paused.
  const { live } = state;
  useEffect(() => {
    if (live.kind === "ending" && now >= live.warnedAt + GRACE_MS) setLive({ kind: "paused", at: now });
  }, [live, now, setLive]);

  // Rental mode's own demo: the state the picked screen draws, and a pretend run from there.
  // Going live and getting paid need rental mode ready: their screens open on a PC where it is.
  const rental = useDemoRental(
    isRentalCase(shown) ? shown : state.step === "live" || state.step === "paid" ? "rental-installed" : null,
    state.clockAt,
  );
  const rate = buildRate(DEMO_HARDWARE_RATE, state.standing);
  const view: HostView = {
    demo: true,
    now,
    machine: DEMO_MACHINE,
    pc: { reading: false, hardware: DEMO_HARDWARE, hardwareRate: DEMO_HARDWARE_RATE },
    games: { installed: DEMO_INSTALLED, offered, demand: DEMO_DEMAND, near: DEMO_NEAR },
    steam: { ...DEMO_STEAM, asked },
    rental: rental.setup,
    standing: state.standing,
    earlyEnd: { reliability: DEMO_EARLY_END_RELIABILITY },
    rate,
    earnings: DEMO_EARNINGS,
    live,
    plan,
    sessionsToday: 1,
    connection: {
      url: "hushed-otter-42.trycloudflare.com",
      machineId: "gaming-pc-1",
      machineKey: "demo-machine-key",
      name: DEMO_MACHINE,
      notice: null,
      preview: null,
    },
    payoutSaved: state.payoutSaved,
    crew,
  };

  const waiting = (until: number | null): Live => ({ kind: "waiting", since: now, until, registered: true });
  const actions = {
    plan: (at: number | null) => setPicked({ at }),
    goLive: () => setLive(waiting(plan)),
    setUntil: (until: number | null) =>
      setState((s) => (s.live.kind === "waiting" ? { ...s, live: { ...s.live, until } } : s)),
    pause: () =>
      setState((s) => (s.live.kind === "waiting" ? { ...s, live: { kind: "paused", at: now } } : s)),
    resume: () => setState((s) => (s.live.kind === "paused" ? { ...s, live: waiting(plan) } : s)),
    setStopNew: (stopNew: boolean) =>
      setState((s) => (s.live.kind === "session" ? { ...s, live: { ...s.live, stopNew } } : s)),
    notifyAtEnd: () =>
      setState((s) => (s.live.kind === "session" ? { ...s, live: { ...s.live, notify: true } } : s)),
    endEarly: () =>
      setState((s) =>
        s.live.kind === "session"
          ? {
              ...s,
              standing: {
                ...s.standing,
                reliability: DEMO_EARLY_END_RELIABILITY,
                was: s.standing.reliability,
              },
              live: { kind: "ending", until: s.live.until, claim: s.live.claim, warnedAt: now },
            }
          : s,
      ),
    cancelEnd: () =>
      setState((s) =>
        s.live.kind === "ending"
          ? {
              ...s,
              live: {
                kind: "session",
                since: s.live.claim.at,
                until: s.live.until,
                claim: s.live.claim,
                playerHere: true,
                stopNew: false,
                notify: false,
                atPc: true,
              },
            }
          : s,
      ),
    retry: () => setState((s) => (s.live.kind === "offline" ? { ...s, live: waiting(s.live.until) } : s)),
    toggleOffer: (appid: number) =>
      setOffered((list) => (list.includes(appid) ? list.filter((id) => id !== appid) : [...list, appid])),
    saveConnection: async () => setLive(waiting(plan)),
    savePayout: () => setState((s) => ({ ...s, payoutSaved: true })),
    // Steam is installed in the demo, and nothing is sent to it.
    installSteam: () => {},
    askInstall: (appid: number) => setAsked((list) => (list.includes(appid) ? list : [...list, appid])),
    ...rental.actions,
    goLiveRental: () => setLive(waiting(plan)),
    setCrews: (ids: string[]) => setCrew((was) => playingFor(was, ids)),
    seats,
  };

  return {
    view,
    actions,
    step: state.step,
    setStep: (step) => setState((s) => ({ ...s, step, setupDone: s.setupDone || step === "live" })),
    jump: (next) => {
      setShown(next);
      setState(demoState(next));
      const at = Date.now();
      setMountedAt(at);
      setTick(at);
    },
    setupDone: state.setupDone,
  };
}
