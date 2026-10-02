import { useEffect, useRef } from "react";
import { MotionContext } from "@swiff/ui";
import { Chrome } from "./Chrome";
import { GameMenu } from "./GameMenu";
import { Ignition } from "./Ignition";
import { Profile } from "./Profile";
import { Session } from "./Session";
import { EstimateSheet, SharePC } from "./SharePC";
import { Wall } from "./Wall";
import { useDisplay } from "./display";
import { useSwiff } from "./useSwiff";

const SESSION_LABEL = { quick: "1 h", evening: "3 h", night: "All night" } as const;

/** Screen switch plus the shared chrome. Every screen reads one hook. */
export function Swiff() {
  const swiff = useSwiff();
  useDisplay();
  const { screen, phase, profile, libraryConnected, pool, machines } = swiff;

  // The app scrolls as one page; a new screen starts at its top.
  const page = useRef<HTMLDivElement>(null);
  // While Ignition, a session or the estimate sheet covers the page, nothing
  // behind it can be focused or pressed: a second hold must not start the
  // launch over.
  const sheet = screen === "share" && swiff.estimateOpen;
  const behind = useRef<HTMLDivElement>(null);
  useEffect(() => {
    behind.current?.toggleAttribute("inert", phase !== "idle" || sheet);
  }, [phase, sheet]);
  useEffect(() => {
    page.current?.scrollTo(0, 0);
  }, [screen, swiff.game?.id]);

  const live =
    screen === "game"
      ? `${machines.filter((m) => !m.busy).length} free for this game`
      : `${Object.values(pool).filter((m) => !m.busy && !m.self).length} free near you`;

  return (
    <div className="sw" data-screen={screen} ref={page}>
      <MotionContext.Provider value={swiff.motion}>
        <div className="sw-page" ref={behind}>
          <Chrome
            screen={screen}
            onHome={swiff.goHome}
            onProfile={() => swiff.setScreen("profile")}
            onShare={swiff.openShare}
            onBack={screen === "game" ? swiff.goHome : undefined}
            live={live}
            renter={
              libraryConnected
                ? {
                    persona: profile?.persona ?? "",
                    session: { label: SESSION_LABEL[swiff.session], onCycle: swiff.cycleSession },
                  }
                : undefined
            }
          />
          {screen === "home" ? <Wall swiff={swiff} /> : null}
          {screen === "game" ? <GameMenu swiff={swiff} /> : null}
          {screen === "profile" ? <Profile swiff={swiff} /> : null}
          {screen === "share" ? <SharePC swiff={swiff} /> : null}
        </div>
        {sheet ? <EstimateSheet swiff={swiff} /> : null}
        {phase === "connecting" ? <Ignition swiff={swiff} /> : null}
        {phase === "live" ? <Session swiff={swiff} /> : null}
      </MotionContext.Provider>
    </div>
  );
}
