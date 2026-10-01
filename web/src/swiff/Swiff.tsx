import { AppShell, MotionContext } from "@swiff/ui";
import { GameMenu } from "./GameMenu";
import { Ignition } from "./Ignition";
import { Profile } from "./Profile";
import { Session } from "./Session";
import { Wall } from "./Wall";
import { useDisplay } from "./display";
import { useSwiff } from "./useSwiff";

const SESSION_LABEL = { quick: "1 h", evening: "3 h", night: "All night" } as const;

/** Screen switch plus the shared chrome. Every screen reads one hook. */
export function Swiff() {
  const swiff = useSwiff();
  useDisplay();
  const { screen, phase, profile, libraryConnected, hoverId, games } = swiff;

  const hovered = games.find((game) => game.id === hoverId);
  const initial = libraryConnected ? (profile?.persona || "?")[0]!.toUpperCase() : "?";

  return (
    <AppShell
      onHome={swiff.goHome}
      onProfile={() => swiff.setScreen("profile")}
      onBack={screen === "game" ? swiff.goHome : undefined}
      session={
        libraryConnected ? { label: SESSION_LABEL[swiff.session], onCycle: swiff.cycleSession } : undefined
      }
      avatar={{
        initial,
        ring: libraryConnected ? "live" : "idle",
        label: `Profile, ${profile?.persona ?? "not signed in"}`,
      }}
      tint={
        hovered
          ? `radial-gradient(ellipse at 30% 30%, hsl(${hovered.hue} 60% 60% / .12), transparent 55%)`
          : undefined
      }
      floating={screen === "game"}
    >
      <MotionContext.Provider value={swiff.motion}>
        {screen === "home" ? <Wall swiff={swiff} /> : null}
        {screen === "game" ? <GameMenu swiff={swiff} /> : null}
        {screen === "profile" ? <Profile swiff={swiff} /> : null}
        {phase === "connecting" ? <Ignition swiff={swiff} /> : null}
        {phase === "live" ? <Session swiff={swiff} /> : null}
      </MotionContext.Provider>
    </AppShell>
  );
}
