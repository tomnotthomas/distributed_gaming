import { useEffect, useRef, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import { DEMO_SCREENS, demoArt, type DemoScreen } from "./demo";
import { WINDOWS_SHARE } from "./devShare";
import { clock } from "./format";
import { glanceOf, type Host, type Step, type TrayAction } from "./model";
import { GetPaid } from "./screens/GetPaid";
import { GoLive } from "./screens/GoLive";
import { Ending, InUse, Offline, Paused, Streaming, Waiting } from "./screens/Live";
import { Settings } from "./screens/Settings";
import { stepLocked } from "./rental";
import { RentalSetupScreen } from "./screens/Rental";
import { Games, ReadPc } from "./screens/Setup";
import { SteamSetup } from "./screens/Steam";
import { TrayDesk } from "./screens/Tray";
import type { ScreenProps } from "./screens/types";
import { loadSetupDone, saveSetupDone } from "./settings";
import { ArtContext } from "./ui/art";
import { Rail } from "./ui/Rail";
import { useDemoHost } from "./useDemoHost";
import { unpaid, usePaidGaming } from "./features";
import { useHost } from "./useHost";

/**
 * Carry out an action the tray glance asked for, only while it is still the
 * action the glance offers: a click on a stale glance does nothing.
 */
export function trayDo({ view, actions }: Host, action: TrayAction) {
  if (glanceOf(view).action?.id !== action) return;
  switch (action) {
    case "stop-new":
      return actions.setStopNew(true);
    case "allow-new":
      return actions.setStopNew(false);
    case "pause":
      return actions.pause();
    case "resume":
      return actions.resume();
    case "retry":
      return actions.retry();
  }
}

/** Keep the tray glance in step with the app, and take its actions. */
function useTray({ view, actions }: Host) {
  const snapshot = JSON.stringify(glanceOf(view));
  useEffect(() => {
    bridge()?.setGlance(JSON.parse(snapshot));
  }, [snapshot]);
  const latest = useRef({ view, actions });
  latest.current = { view, actions };
  useEffect(() => bridge()?.onTrayAction((action) => trayDo(latest.current, action)), []);
}

/** The Go live step shows whichever screen the live state is in. */
function LiveStep(props: ScreenProps) {
  const { live } = props.view;
  switch (live.kind) {
    case "off":
    case "starting":
      return <GoLive {...props} />;
    case "waiting":
      return <Waiting {...props} live={live} />;
    case "session":
      return live.atPc ? <InUse {...props} live={live} /> : <Streaming {...props} live={live} />;
    case "ending":
      return <Ending {...props} live={live} />;
    case "paused":
      return <Paused {...props} live={live} />;
    case "offline":
      return <Offline {...props} live={live} />;
  }
}

const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** The window: the rail, and the step it is on. */
export function Shell({
  host,
  step,
  onStep,
  setupDone,
  finishSetup,
  foot,
  paid,
}: {
  host: Host;
  step: Step;
  onStep: (step: Step) => void;
  setupDone: boolean;
  finishSetup: () => void;
  foot?: ReactNode;
  /** Paid gaming is on at the server (features.ts): the app shows earning, levels and the rate. */
  paid: boolean;
}) {
  // While paid gaming is off nothing about money shows, and there is no "Get paid" step.
  const view = paid ? host.view : unpaid(host.view);
  useTray({ ...host, view });
  const props: ScreenProps = { view, actions: host.actions, go: onStep };
  // A step that is still locked shows rental mode, the step it waits for, and opens by itself once it is ready.
  const locked = stepLocked(step, view, WINDOWS_SHARE) ? "rental" : step;
  const shown = locked === "paid" && !paid ? "live" : locked;
  const screen = (() => {
    switch (shown) {
      case "pc":
        return <ReadPc {...props} setupDone={setupDone} />;
      case "steam":
        return <SteamSetup {...props} />;
      case "games":
        return <Games {...props} finishSetup={finishSetup} />;
      case "rental":
        return <RentalSetupScreen {...props} />;
      case "live":
        return <LiveStep {...props} />;
      case "paid":
        return <GetPaid {...props} />;
      case "settings":
        return <Settings {...props} />;
    }
  })();
  return (
    <div className={MAC ? "hx mac" : "hx"}>
      <div className="titlebar" aria-hidden="true" />
      <Rail view={view} step={shown} setupDone={setupDone} onStep={onStep} foot={foot} paid={paid} />
      {screen}
    </div>
  );
}

/** A build packaged by `npm run pack:test` (build-kind.cjs): main opens the window with build=test. */
const TEST_BUILD = new URLSearchParams(location.search).get("build") === "test";

/** The app on this PC's own data. The first run starts at reading the PC; later ones at Go live. */
export function RealApp() {
  const host = useHost();
  const paid = usePaidGaming(host.view.connection.url);
  const [setupDone, setSetupDone] = useState(loadSetupDone);
  const [step, setStep] = useState<Step>(() => (loadSetupDone() ? "live" : "pc"));
  return (
    <Shell
      host={host}
      step={step}
      onStep={setStep}
      setupDone={setupDone}
      finishSetup={() => {
        saveSetupDone();
        setSetupDone(true);
      }}
      foot={TEST_BUILD ? <span className="build-tag">Test build</span> : undefined}
      paid={paid}
    />
  );
}

/** The app on its labelled demo data, with a picker for each of the design's screens. */
export function DemoApp({ screen: first }: { screen: DemoScreen }) {
  const [screen, setScreen] = useState<DemoScreen>(first);
  const demo = useDemoHost(first);
  const jump = (next: DemoScreen) => {
    setScreen(next);
    demo.jump(next);
  };
  const picker = (
    <label className="demo-pick">
      <span className="mono">Screen</span>
      <select value={screen} onChange={(event) => jump(event.target.value as DemoScreen)}>
        {DEMO_SCREENS.map((s, i) => (
          <option key={s.id} value={s.id}>
            A{i + 1} {s.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <ArtContext.Provider value={demoArt}>
      {screen === "tray" ? (
        <div className="hx deskwrap">
          <TrayDesk
            glance={glanceOf(demo.view)}
            clock={clock(demo.view.now)}
            onAction={(action) => (action === "open" ? jump("streaming") : trayDo(demo, action))}
          />
          <div className="desk-pick">{picker}</div>
        </div>
      ) : (
        <Shell
          host={demo}
          step={demo.step}
          onStep={demo.setStep}
          setupDone={demo.setupDone}
          finishSetup={() => demo.setStep("live")}
          foot={picker}
          paid={false}
        />
      )}
    </ArtContext.Provider>
  );
}
