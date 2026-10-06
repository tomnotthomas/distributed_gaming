import { useEffect, useMemo, useRef } from "react";
import { MotionContext } from "@swiff/ui";
import { Chrome } from "./Chrome";
import { GameMenu } from "./GameMenu";
import { Ignition } from "./Ignition";
import { CrewInvite } from "./CrewInvite";
import { SeatInvite } from "./SeatInvite";
import { CrewPage } from "./CrewPage";
import { CrewReadyBanner } from "./CrewsCard";
import { Profile } from "./Profile";
import { AwayDialog, MachineLost, QueueBackDialog } from "./Reconnect";
import { Session } from "./Session";
import { screenLang, screenText } from "./screenCopy";
import { EstimateSheet, SharePC } from "./SharePC";
import { Wall } from "./Wall";
import { useDisplay } from "./display";
import { useSwiff } from "./useSwiff";

/** Screen switch plus the shared chrome. Every screen reads one hook. */
export function Swiff() {
  const swiff = useSwiff();
  useDisplay();
  const { screen, phase, profile, signedIn } = swiff;
  const t = useMemo(() => screenText(screenLang(screen)), [screen]);

  // The app scrolls as one page; a new screen starts at its top.
  const page = useRef<HTMLDivElement>(null);
  // While Ignition, a session or the estimate sheet covers the page, nothing
  // behind it can be focused or pressed: a second hold must not start the
  // launch over.
  const sheet = screen === "share" && swiff.estimateOpen;
  // Coming back to a session still running, or to a place in the queue, is
  // asked first; a session carried on from a lost machine covers the page too.
  const back = phase === "idle" && (swiff.away !== null || swiff.queueBack || swiff.lost !== null);
  const behind = useRef<HTMLDivElement>(null);
  useEffect(() => {
    behind.current?.toggleAttribute("inert", phase !== "idle" || sheet || back);
  }, [phase, sheet, back]);
  useEffect(() => {
    page.current?.scrollTo(0, 0);
  }, [screen, swiff.game?.id]);

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
            live={swiff.liveLine}
            freed={swiff.motion && swiff.freed.size > 0}
            renter={
              signedIn
                ? {
                    persona: profile?.persona ?? "",
                    session: { label: t(`session.${swiff.session}`), onCycle: swiff.cycleSession },
                  }
                : undefined
            }
          />
          {screen === "home" ? <Wall swiff={swiff} /> : null}
          {screen === "game" ? <GameMenu swiff={swiff} /> : null}
          {screen === "profile" ? <Profile swiff={swiff} /> : null}
          {screen === "share" ? <SharePC swiff={swiff} /> : null}
          {screen === "invite" ? <CrewInvite swiff={swiff} /> : null}
          {screen === "seat" ? <SeatInvite swiff={swiff} /> : null}
          {screen === "crew" ? <CrewPage swiff={swiff} /> : null}
          {phase === "idle" ? <CrewReadyBanner swiff={swiff} /> : null}
        </div>
        {sheet ? <EstimateSheet swiff={swiff} /> : null}
        {phase === "idle" && swiff.lost ? <MachineLost swiff={swiff} /> : null}
        {phase === "idle" && !swiff.lost ? <AwayDialog swiff={swiff} /> : null}
        {phase === "idle" && !swiff.lost && !swiff.away ? <QueueBackDialog swiff={swiff} /> : null}
        {phase === "connecting" ? <Ignition swiff={swiff} /> : null}
        {/* A claimed launch's stream plays behind Ignition until its game is on screen. */}
        {phase === "live" || (phase === "connecting" && swiff.claim && !swiff.demo) ? (
          <Session swiff={swiff} />
        ) : null}
      </MotionContext.Provider>
    </div>
  );
}
