// The crew's vote on who plays next, as a ticket over the stream (f-stream
// impeccable, s=2): who wants to play what, the tally, the time left, and yes
// or no; once decided, what the crew said. The viewer (Watch.tsx) and the
// player's own screen (SwitchToast.tsx) both show it.

import { useState } from "react";
import { artUrl, headerUrl } from "./data";
import { PhIcon } from "./PhIcon";
import type { streamText } from "./streamCopy";
import { clockOf, secondsLeft, type SwitchView } from "./switch";

/** A game's wide art, falling back to its store header. */
export function GameArt({ appid }: { appid: number }) {
  return (
    <img
      src={artUrl(appid, 1)}
      alt=""
      loading="lazy"
      onError={(event) => {
        const img = event.currentTarget;
        if (img.src !== headerUrl(appid)) img.src = headerUrl(appid);
      }}
    />
  );
}

/** The crew's vote, as a ticket over the stream: who wants what, the tally, the timer, and yes or no. */
export function VoteTicket({
  view,
  now,
  game,
  player,
  t,
  onVote,
}: {
  view: SwitchView;
  now: number;
  game: string;
  player: string;
  t: ReturnType<typeof streamText>;
  onVote: (yes: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const proposer = view.proposer ?? t("w.someone");
  const vote = (yes: boolean) => {
    setBusy(true);
    void onVote(yes).finally(() => setBusy(false));
  };
  if (view.outcome !== "open") {
    if (view.playing && view.outcome === "yes") return null;
    const left = clockOf(secondsLeft(view.switchAt ?? now, now));
    return (
      <div className="st-vote decided" role="status" data-outcome={view.outcome}>
        <div className="v-top">
          <GameArt appid={view.gameId} />
          <p>
            <b>
              {view.outcome === "no"
                ? t("v.decidedNo", { player })
                : view.mine
                  ? t("v.youNext")
                  : t("v.decidedYes", { name: proposer })}
            </b>
            {view.outcome === "yes" ? (
              <span>{t(view.mine ? "v.youNextLine" : "v.decidedYesLine", { player, time: left })}</span>
            ) : null}
          </p>
        </div>
      </div>
    );
  }
  const left = clockOf(secondsLeft(view.endsAt, now));
  return (
    <div className="st-vote" role="dialog" aria-labelledby="st-vote-h">
      <div className="v-top">
        <GameArt appid={view.gameId} />
        <p>
          <b id="st-vote-h">
            {view.mine ? t("v.youWant", { game }) : t("v.wants", { name: proposer, game })}
          </b>
          <span>{view.playing ? t("v.youHandOver") : t("v.handOver", { player })}</span>
        </p>
      </div>
      <div className="v-mid">
        <div className="v-tally" aria-hidden="true">
          {Array.from({ length: view.voters }, (_, i) => (
            <span key={i} className={i < view.yes ? "y" : i >= view.voters - view.no ? "n" : undefined} />
          ))}
        </div>
        <p className="v-tally-t">
          <span>{t("v.tally", { n: view.yes, of: view.voters })}</span>
          <span>{t("v.left", { time: left })}</span>
        </p>
        {view.canVote && !view.mine ? (
          <div className="v-acts">
            <button
              type="button"
              className="yes"
              disabled={busy}
              aria-pressed={view.vote === "yes"}
              onClick={() => vote(true)}
            >
              <PhIcon name="thumbs-up" size={18} />
              <span>{t("v.yes")}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              aria-pressed={view.vote === "no"}
              onClick={() => vote(false)}
            >
              <PhIcon name="thumbs-down" size={18} />
              <span>{t("v.no")}</span>
            </button>
          </div>
        ) : null}
        <p className="v-fine">
          {view.mine
            ? t("v.waiting")
            : view.vote === "yes" && !view.playing
              ? t("v.waiting")
              : view.vote === "no"
                ? t("v.saidNo")
                : view.playing
                  ? t("v.youFine")
                  : t("v.fine", { player })}
        </p>
      </div>
    </div>
  );
}
