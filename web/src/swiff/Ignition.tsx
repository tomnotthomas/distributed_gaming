import { Button, ProgressRing } from "@swiff/ui";
import type { Swiff } from "./useSwiff";

/** The wait between Launch and a frame, named step by step so it is not a spinner. */
export function Ignition({ swiff }: { swiff: Swiff }) {
  const { game, picked, progress, ignitionStep } = swiff;
  return (
    <div className="ignition" data-testid="ignition">
      <div className="ignition-glow" />
      <div className="ignition-stack">
        <ProgressRing pct={progress}>{Math.round(progress * 100)}%</ProgressRing>
        <div className="ignition-text">
          <div className="ignition-step">{ignitionStep}</div>
          <div className="ignition-where">
            {game?.title} on {picked?.name ?? "a machine"}
          </div>
        </div>
        <Button variant="secondary" onClick={swiff.goHome}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
