// The crew's vote on who plays next, over the player's own game (f-stream
// impeccable, s=2 and s=5): while it is open, the ticket with the tally and a
// yes or no of their own (their yes switches at once); once the crew said yes,
// a countdown to save in, with "Saved, switch now" and "+2 minutes". When it
// runs out the server ends the session, and the PC goes to the one who asked.

import { useMemo, useState } from "react";
import { useGameNames } from "./CrewPlay";
import { streamText } from "./streamCopy";
import { clockOf, handOver, secondsLeft, useSwitch, voteSwitch } from "./switch";
import type { Swiff } from "./useSwiff";
import { VoteTicket } from "./VoteTicket";

export function SwitchToast({ swiff, sessionId }: { swiff: Swiff; sessionId: string | null }) {
  const t = useMemo(() => streamText(swiff.lang), [swiff.lang]);
  const { view, now, set } = useSwitch(sessionId);
  const [busy, setBusy] = useState(false);
  const names = useGameNames(view ? [view.gameId] : [], swiff.games);
  if (!sessionId || !view) return null;
  const me = swiff.profile?.persona || t("w.someone");

  if (view.outcome !== "yes") {
    if (view.outcome === "no") return null;
    return (
      <div className="sw-stream-over" data-testid="switch-vote">
        <VoteTicket
          view={view}
          now={now}
          game={names.get(view.gameId) ?? ""}
          player={me}
          t={t}
          onVote={async (yes) => set(await voteSwitch(sessionId, yes))}
        />
      </div>
    );
  }

  const proposer = view.proposer ?? t("w.someone");
  const left = clockOf(secondsLeft(view.switchAt ?? now, now));
  const ask = (what: "now" | "more") => {
    setBusy(true);
    void handOver(sessionId, what)
      .then(set)
      .finally(() => setBusy(false));
  };
  return (
    <div className="sw-stream-over" data-testid="switch-save">
      <div className="st-toast" role="status">
        <span className="st-clock">{left}</span>
        <p>
          <b>{t("s.title", { name: proposer })}</b>
          <span>{t("s.line", { name: proposer, time: left })}</span>
          <span className="st-row">
            <button type="button" className="st-solid" disabled={busy} onClick={() => ask("now")}>
              {t("s.now")}
            </button>
            {view.moreLeft > 0 ? (
              <button type="button" className="st-plain" disabled={busy} onClick={() => ask("more")}>
                {t("s.more")}
              </button>
            ) : null}
          </span>
        </p>
      </div>
    </div>
  );
}
