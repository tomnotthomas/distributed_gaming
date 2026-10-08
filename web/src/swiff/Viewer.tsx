// Watching a crewmate play, full screen (data/lanterel-design-round, f-stream
// impeccable): the stream is the page, and its controls float over it on dark
// glass. Top left who plays what on whose PC; top right the crew menu (who is
// here, back to the crew page, leaving the crew) and leaving the stream; at
// the bottom sound, mic and "I want to play", which asks the crew to vote
// (switch.ts). A vote comes as a ticket over the stream with its tally and
// timer. Nothing typed, clicked or held here reaches the game.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Lang } from "./crewCopy";
import { fetchCrew, removeCrewMember, type CrewDetail } from "./crews";
import { useGameNames } from "./CrewPlay";
import { usePushKey } from "./Crew";
import { initials } from "./Chrome";
import { PhIcon } from "./PhIcon";
import { streamText, theirSession } from "./streamCopy";
import { askToPlay, useSwitch, voteSwitch, type SwitchView } from "./switch";
import { GameArt, VoteTicket } from "./VoteTicket";
import type { Swiff } from "./useSwiff";
import { useWatching, type WatchState } from "./watch";

/** The key a viewer holds to talk on push to talk: nothing else on this page reads the keyboard. */
const PUSH_KEY = "KeyV";

/** The most of the viewer's games "I want to play" offers. */
const MAX_PICKS = 6;

type Panel = "menu" | "who" | "leave" | "pick" | null;

export function Watch({ swiff }: { swiff: Swiff }) {
  const entry = swiff.watching;
  const lang = swiff.lang;
  const t = useMemo(() => streamText(lang), [lang]);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  // The viewer's own choice of sound; until they make one, on unless the browser held it back.
  const [soundChoice, setSoundChoice] = useState<boolean | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [crew, setCrew] = useState<CrewDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A note says its piece, then goes.
  useEffect(() => {
    if (!note) return;
    const gone = setTimeout(() => setNote(null), 4_000);
    return () => clearTimeout(gone);
  }, [note]);
  const { state, session, muteForMe } = useWatching(entry?.sessionId ?? null, video);
  const watching = state.phase === "watching";
  const vote = useSwitch(watching && entry ? entry.sessionId : null);
  /** Push to talk, for the push key. */
  const talk = useCallback((on: boolean) => session?.setTalking(on), [session]);
  usePushKey(PUSH_KEY, state.voice.inVoice && state.voice.mode === "push", talk);

  const crewId = entry?.crew ?? null;
  useEffect(() => {
    if (!crewId) return;
    let live = true;
    void fetchCrew(crewId).then((read) => {
      if (live && read && read !== "gone") setCrew(read);
    });
    return () => {
      live = false;
    };
  }, [crewId]);

  // The PC being watched, and the viewer's games on it, the most played first.
  const pc = crew?.machines.find((m) => m.playing?.sessionId === entry?.sessionId);
  const picks = useMemo(
    () =>
      swiff.games
        .filter((g) => pc?.games.includes(g.appid) && g.appid !== entry?.gameId)
        .sort((a, b) => b.hours - a.hours)
        .slice(0, MAX_PICKS),
    [swiff.games, pc, entry?.gameId],
  );
  const names = useGameNames(
    [entry?.gameId, vote.view?.gameId].filter((id): id is number => id !== undefined),
    swiff.games,
  );

  if (!entry) return null;

  const player = state.player ?? entry.player ?? t("w.someone");
  const game = names.get(entry.gameId) ?? t("w.theirGame");
  const showing = watching && state.framed;
  const me = crew?.members.find((m) => m.you);

  /** Sound on and off: the browser may have held it back until the viewer chose it. */
  const soundIsOn = soundChoice ?? !state.muted;
  const toggleSound = () => {
    if (!video) return;
    const on = !soundIsOn;
    video.muted = !on;
    if (on) void video.play().catch(() => {});
    setSoundChoice(on);
  };

  /** The mic: joins the voice chat first, then mutes and unmutes. */
  const toggleMic = () => {
    if (!session) return;
    if (!state.voice.inVoice) void session.joinVoice();
    else session.setMuted(!state.voice.muted);
  };
  const micOn = state.voice.inVoice && !state.voice.muted;

  const toCrewPage = () => {
    swiff.stopWatching();
    swiff.openCrew(crewId ?? undefined);
  };
  const leaveCrew = async () => {
    if (!me) return;
    setBusy(true);
    const done = await removeCrewMember(me.id);
    setBusy(false);
    if (!done) return setNote(t("m.failed"));
    swiff.stopWatching();
    swiff.openCrew();
  };

  return (
    <div
      className="sw-stream"
      data-testid="watch"
      data-phase={state.phase}
      onKeyDown={(event) => {
        if (event.key === "Escape") setPanel(null);
      }}
    >
      <video
        className="st-video"
        data-testid="watch-video"
        ref={setVideo}
        autoPlay
        playsInline
        hidden={!showing}
        aria-label={t("w.stream", { game, name: player })}
      />

      <div className="st-tl st-glass">
        <span className="st-av" aria-hidden="true">
          {initials(player)}
        </span>
        <p>
          <b>{t("w.playing", { name: player, game })}</b>
          <span>
            {[
              entry.machine ? t("w.on", { pc: entry.machine }) : null,
              watching && state.roster.length ? t("w.watchingN", { n: viewersOf(state) }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
        {showing ? <i className="st-live" aria-hidden="true" /> : null}
      </div>

      <div className="st-tr">
        {crewId ? (
          <button
            type="button"
            className="st-btn st-glass"
            aria-expanded={panel === "menu" || panel === "who" || panel === "leave"}
            aria-label={t("w.crew")}
            onClick={() => setPanel(panel === "menu" ? null : "menu")}
          >
            <PhIcon name="dots-three" />
            <span className="t">{t("w.crew")}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="st-btn st-glass"
          aria-label={t("w.leave")}
          onClick={swiff.stopWatching}
        >
          <PhIcon name="x" />
          <span className="t">{t("w.leave")}</span>
        </button>
      </div>

      {watching ? <VoiceRail state={state} player={player} /> : null}

      {panel === "menu" ? (
        <div className="st-menu st-glass" role="menu">
          <button type="button" role="menuitem" onClick={() => setPanel("who")}>
            <PhIcon name="users" />
            <span>{t("m.who")}</span>
          </button>
          <button type="button" role="menuitem" onClick={toCrewPage}>
            <PhIcon name="game-controller" />
            <span>{t("m.back")}</span>
          </button>
          {me ? (
            <>
              <hr />
              <button type="button" role="menuitem" className="danger" onClick={() => setPanel("leave")}>
                <PhIcon name="sign-out" />
                <span>{t("m.leaveCrew")}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {panel === "who" ? (
        <div className="st-menu st-glass st-who" role="group" aria-label={t("m.who")}>
          <WhoIsHere state={state} player={player} onMute={muteForMe} t={t} />
        </div>
      ) : null}

      {panel === "leave" ? (
        <div className="st-menu st-glass st-ask" role="group" aria-labelledby="st-leave-h">
          <h2 id="st-leave-h">{t("m.leaveTitle")}</h2>
          <p>{t("m.leaveLine")}</p>
          <div className="st-acts">
            <button
              type="button"
              className="st-solid danger"
              disabled={busy}
              onClick={() => void leaveCrew()}
            >
              {t("m.leaveYes")}
            </button>
            <button type="button" className="st-plain" onClick={() => setPanel(null)}>
              {t("m.leaveNo")}
            </button>
          </div>
        </div>
      ) : null}

      {showing ? null : (
        <WatchWait
          state={state}
          player={player}
          t={t}
          lang={lang}
          next={vote.view}
          nextGame={vote.view ? (names.get(vote.view.gameId) ?? "") : ""}
          onLeave={swiff.stopWatching}
          onCrew={crewId ? toCrewPage : undefined}
        />
      )}

      {watching && panel === "pick" ? (
        <Pick
          picks={picks}
          player={player}
          t={t}
          onCancel={() => setPanel(null)}
          onAsk={async (gameId) => {
            const answer = await askToPlay(entry.sessionId, gameId);
            if (answer.ok) {
              vote.set(answer);
              setPanel(null);
            } else setNote(t(answer.status === 409 ? "p.busy" : "m.failed"));
          }}
        />
      ) : null}

      {watching && panel !== "pick" && vote.view ? (
        <VoteTicket
          view={vote.view}
          now={vote.now}
          game={names.get(vote.view.gameId) ?? ""}
          player={player}
          t={t}
          onVote={async (yes) => {
            const answer = await voteSwitch(entry.sessionId, yes);
            if (answer.ok) vote.set(answer);
            else setNote(t("m.failed"));
          }}
        />
      ) : null}

      <p className="st-note" role="status" aria-live="polite" hidden={!note}>
        {note}
      </p>

      {watching ? (
        <div className="st-bar st-glass" data-testid="watch-crew">
          <button type="button" className={soundIsOn ? "st-btn" : "st-btn off"} onClick={toggleSound}>
            <PhIcon name={soundIsOn ? "speaker-high" : "speaker-slash"} />
            <span className="t">{t(soundIsOn ? "w.soundOn" : "w.soundOff")}</span>
          </button>
          <button
            type="button"
            className={micOn ? "st-btn" : "st-btn off"}
            aria-pressed={state.voice.inVoice ? micOn : undefined}
            aria-label={state.voice.inVoice ? t("w.micOn") : t("w.joinVoice")}
            onClick={toggleMic}
          >
            <PhIcon name={micOn ? "microphone" : "microphone-slash"} />
            <span className="t">
              {state.voice.inVoice ? t(micOn ? "w.micOn" : "w.micOff") : t("w.joinVoice")}
            </span>
          </button>
          {vote.view?.playing ? null : (
            <>
              <span className="st-sep" aria-hidden="true" />
              <button
                type="button"
                className="st-btn main"
                aria-expanded={panel === "pick"}
                onClick={() =>
                  // While the crew decides, or once it said yes, nobody else asks.
                  vote.view?.outcome === "open" || vote.view?.outcome === "yes"
                    ? setNote(t("p.busy"))
                    : setPanel(panel === "pick" ? null : "pick")
                }
              >
                <PhIcon name="arrows-left-right" />
                <span className="t">{t("w.want")}</span>
              </button>
            </>
          )}
        </div>
      ) : null}
      {state.voice.micRefused || state.voice.mutedByPlayer ? (
        <p className="st-note" role="status">
          {state.voice.micRefused ? t("w.micRefused") : t("w.mutedBy", { name: player })}
        </p>
      ) : null}
    </div>
  );
}

/** How many watch now, as the roster counts them: everyone but the player. */
const viewersOf = (state: WatchState) => state.roster.filter((p) => p.id !== "player").length;

/** The voice chat's people down the right side: everyone in it but this viewer. */
function VoiceRail({ state, player }: { state: WatchState; player: string }) {
  const people = state.roster.filter((p) => p.mid !== null && p.inVoice);
  if (!people.length) return null;
  return (
    <div className="st-voice st-glass">
      {people.map((p) => (
        <span
          key={p.id}
          className={p.muted || p.mutedByPlayer || state.hushed.includes(p.id) ? "st-av mute" : "st-av"}
          title={p.id === "player" ? player : (p.name ?? "")}
        >
          {initials(p.id === "player" ? player : (p.name ?? "?"))}
        </span>
      ))}
    </div>
  );
}

/** Who is in the session: the player and everyone watching, each with a mute of this viewer's own. */
function WhoIsHere({
  state,
  player,
  onMute,
  t,
}: {
  state: WatchState;
  player: string;
  onMute: (id: string, muted: boolean) => void;
  t: ReturnType<typeof streamText>;
}) {
  const others = state.roster.filter((p) => p.mid !== null);
  if (!others.length) return <p className="st-empty">{t("m.nobody")}</p>;
  return (
    <ul>
      {others.map((p) => {
        const hushed = state.hushed.includes(p.id);
        const name = p.id === "player" ? player : (p.name ?? "?");
        return (
          <li key={p.id} data-testid="voice-person">
            <span className="st-av" aria-hidden="true">
              {initials(name)}
            </span>
            <span className="st-nm">
              {name}
              {p.id === "player" ? <small>{t("m.player")}</small> : null}
            </span>
            {p.inVoice && !p.mutedByPlayer ? (
              <button type="button" aria-pressed={hushed} onClick={() => onMute(p.id, !hushed)}>
                {t(hushed ? "m.hear" : "m.muteForMe")}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** "I want to play": one of the viewer's games on the PC, then the crew is asked. */
function Pick({
  picks,
  player,
  t,
  onAsk,
  onCancel,
}: {
  picks: { appid: number; title: string }[];
  player: string;
  t: ReturnType<typeof streamText>;
  onAsk: (gameId: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(picks[0]?.appid ?? null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="st-sheet" role="dialog" aria-labelledby="st-pick-h">
      <h2 id="st-pick-h">{t("p.title")}</h2>
      <p>{t("p.line", { name: player })}</p>
      {picks.length ? (
        <ul className="st-pick">
          {picks.map((g) => (
            <li key={g.appid}>
              <button type="button" aria-pressed={picked === g.appid} onClick={() => setPicked(g.appid)}>
                <GameArt appid={g.appid} />
                <b>{g.title}</b>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="st-empty">{t("p.none")}</p>
      )}
      <div className="st-go">
        <button
          type="button"
          className="st-pill"
          disabled={picked === null || busy}
          onClick={() => {
            if (picked === null) return;
            setBusy(true);
            void onAsk(picked).finally(() => setBusy(false));
          }}
        >
          {t("p.ask")}
          <span className="st-pill-c">
            <PhIcon name="arrow-right" size={16} />
          </span>
        </button>
        <button type="button" className="st-txt" onClick={onCancel}>
          {t("p.cancel")}
        </button>
      </div>
    </div>
  );
}

/** What stands in for the picture: asking, waiting for the stream, or why it is over. */
function WatchWait({
  state,
  player,
  t,
  lang,
  next,
  nextGame,
  onLeave,
  onCrew,
}: {
  state: WatchState;
  player: string;
  t: ReturnType<typeof streamText>;
  lang: Lang;
  next: SwitchView | null;
  nextGame: string;
  onLeave: () => void;
  onCrew: (() => void) | undefined;
}) {
  let title: string;
  let body: string;
  const over = state.phase === "over";
  // The crew voted this viewer plays next, and the session is over: their turn on the crew page.
  const myTurn = over && next?.mine && next.outcome === "yes";
  if (over) {
    title = t("e.notWatching");
    body = myTurn ? t("e.yourTurn", { game: nextGame }) : endedText(t, lang, state.ended, player);
  } else if (state.phase === "asking-server") {
    title = t("e.asking", { name: player });
    body = t("e.askingLine");
  } else if (state.phase === "asking") {
    title = t("e.asked", { name: player });
    body = t("e.askedLine", { name: player });
  } else if (!state.playerHere) {
    title = t("e.waiting", { name: player });
    body = t("e.waitingLine", { name: player });
  } else {
    title = t("e.yes", { name: player });
    body = t("e.yesLine");
  }
  return (
    <div className="st-wait" role="status" data-testid="watch-wait">
      <div className="st-card">
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="st-acts">
          {myTurn && onCrew ? (
            <button type="button" className="st-solid" onClick={onCrew}>
              {t("e.toCrew")}
            </button>
          ) : null}
          <button type="button" className={over && !myTurn ? "st-solid" : "st-plain"} onClick={onLeave}>
            {over ? t("e.back") : state.phase === "watching" ? t("e.leave") : t("e.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What a watch that is over says, for the player named. */
export function endedText(
  t: ReturnType<typeof streamText>,
  lang: Lang,
  ended: WatchState["ended"],
  player: string,
): string {
  switch (ended) {
    case "watch-declined":
      return t("e.declined", { name: player });
    case "watch-unanswered":
      return t("e.unanswered", { name: player });
    case "watch-stopped":
      return t("e.stopped", { name: player });
    case "watch-ended":
    case "gone":
      return t("e.over", { possessive: theirSession(lang, player) });
    case "not-crew":
      return t("e.notCrew", { name: player });
    case "full":
      return t("e.full", { name: player });
    case "cooldown":
      return t("e.cooldown", { name: player });
    case "no-relay":
      return t("e.noRelay");
    case "watch-replaced":
      return t("e.replaced");
    default:
      return t("e.failed");
  }
}
