// The crew page's last step, playing (data/lanterel-design-round, e-start
// impeccable): whoever wants to play starts one of their own games on the
// crew's gaming PC from here, on their own screen, and its owner does nothing.
// First come, first play: while the PC is free, picking a game and starting
// it books the PC; while someone plays on it, the others watch (when the
// player shares) or get in line to go next, with the game they want.

import { useEffect, useMemo, useState } from "react";
import { crewQueue, pcTitle, queueNext, type CrewDetail, type CrewPc } from "./crews";
import { Avatar, useCrewText } from "./crewUi";
import { fetchMedia } from "./catalog";
import { artUrl, headerUrl, type Game } from "./data";
import { Glyph } from "./Glyph";
import { gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

/** The most of the player's games the step offers. */
const MAX_GAMES = 8;

/** The PC the step is about: the one the viewer plays on, else a free one not their own, else their own free one, else one someone plays on, else one that is on, else the first. */
export function playPc(crew: CrewDetail): CrewPc | undefined {
  const free = (m: CrewPc) => m.state === "ready" && !m.playing;
  return (
    crew.machines.find((m) => m.playing?.you) ??
    crew.machines.find((m) => free(m) && !m.mine) ??
    crew.machines.find(free) ??
    crew.machines.find((m) => m.playing) ??
    crew.machines.find((m) => m.state !== "offline") ??
    crew.machines[0]
  );
}

/** Steam's names for games the player's own library does not name, by appid, read once each. */
function useGameNames(appids: number[], games: Game[]): Map<number, string> {
  const [read, setRead] = useState<Map<number, string>>(new Map());
  const missing = appids.filter((id) => !games.some((g) => g.appid === id) && !read.has(id));
  const key = [...new Set(missing)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    void fetchMedia(key.split(",").map(Number)).then((found) => {
      if (!live || !found) return;
      setRead((was) => new Map([...was, ...found.map((g) => [g.appid, g.name] as const)]));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return useMemo(() => new Map([...read, ...games.map((g) => [g.appid, g.title] as const)]), [read, games]);
}

export function CrewPlay({
  crew,
  swiff,
  busy,
  apply,
}: {
  crew: CrewDetail;
  swiff: Swiff;
  busy: boolean;
  apply: (work: Promise<CrewDetail | null>) => Promise<CrewDetail | null>;
}) {
  const { lang, t } = useCrewText();
  const { games, playOn, crewLive, watch, phase, taken, bookingFailed } = swiff;
  const pc = playPc(crew)!;
  const pcName = pcTitle(lang, pc);
  const playing = pc.playing;
  const me = crew.members.find((m) => m.you)!;
  const queue = crewQueue(crew);

  // The player's games installed on the PC, the most played first.
  const mine = useMemo(
    () =>
      games
        .filter((g) => pc.games.includes(g.appid))
        .sort((a, b) => b.hours - a.hours)
        .slice(0, MAX_GAMES),
    [games, pc.games],
  );
  const names = useGameNames(
    [...(playing ? [playing.gameId] : []), ...queue.map((m) => m.next!.gameId)],
    games,
  );
  const nameOf = (appid: number) => names.get(appid) ?? t("pl.aGame");

  const [picked, setPicked] = useState<number | null>(null);
  const choice = mine.find((g) => g.appid === (picked ?? me.next?.gameId)) ?? mine[0] ?? null;
  // A start from here that came back taken or refused: someone else was quicker.
  const [tried, setTried] = useState(false);
  const failed = tried && phase === "idle" && (taken !== null || bookingFailed);

  const start = () => {
    if (!choice) return;
    setTried(true);
    playOn(choice, pc.id);
  };

  const tiles = (onPick: (game: Game) => void, selected: Game | null) =>
    mine.length ? (
      <ul className="pl-games">
        {mine.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              className="pl-game"
              aria-pressed={selected?.id === g.id}
              disabled={busy}
              onClick={() => onPick(g)}
            >
              <span className="pl-sel" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <img src={gameArt(g, 1)} alt="" loading="lazy" />
              <span className="pl-gt">
                <b>{g.title}</b>
              </span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="gc-fine">{games.length ? t("pl.none", { pc: pcName }) : t("pl.loading")}</p>
    );

  const queueList = queue.length ? (
    <>
      <p className="pl-k">{t("pl.queue")}</p>
      <ol className="pl-queue">
        {queue.map((m, i) => (
          <li key={m.id} className={m.you ? "me" : undefined}>
            <Avatar name={m.name ?? t("cp.anon")} index={i} />
            {m.you ? t("pl.queueYou") : (m.name ?? t("cp.anon"))}
            <small>{nameOf(m.next!.gameId)}</small>
          </li>
        ))}
      </ol>
    </>
  ) : null;

  if (playing && !playing.you) {
    const entry = crewLive?.find((e) => e.sessionId === playing.sessionId);
    const who = playing.player ?? t("pl.someone");
    const game = nameOf(playing.gameId);
    const minutes =
      playing.startedAt === null ? null : Math.max(1, Math.round((Date.now() - playing.startedAt) / 60_000));
    const art = artUrl(playing.gameId, 1);
    return (
      <div className="pl" data-play="busy">
        <div className="pl-now">
          <div className="pl-shot">
            <img
              src={art}
              alt={game}
              onError={(event) => {
                const img = event.currentTarget;
                if (img.src !== headerUrl(playing.gameId)) img.src = headerUrl(playing.gameId);
              }}
            />
          </div>
          <div className="pl-now-b">
            <h2>{t(playing.starting ? "pl.startingH" : "pl.playingH", { name: who, game })}</h2>
            <p className="pl-cap">
              {minutes !== null ? <span>{t("pl.for", { n: minutes })}</span> : null}
              <span>{t("pl.on", { pc: pcName })}</span>
              {entry?.watching ? <span>{t("pl.watching", { n: entry.watching })}</span> : null}
            </p>
            <div className="gc-acts">
              <button
                type="button"
                className="lpill solid"
                disabled={!entry || entry.starting}
                onClick={() => entry && watch(entry)}
              >
                {t("pl.watch")}
                <span className="lpill-c">
                  <Glyph name="eye" size={18} />
                </span>
              </button>
              {me.next ? (
                <button
                  type="button"
                  className="gc-ghost"
                  disabled={busy}
                  onClick={() => void apply(queueNext(crew.id, null))}
                >
                  {t("pl.leave")}
                </button>
              ) : pc.mine ? null : (
                <button
                  type="button"
                  className="gc-ghost"
                  disabled={busy || !choice}
                  onClick={() => choice && void apply(queueNext(crew.id, choice.appid))}
                >
                  <Glyph name="hand" size={18} />
                  {t("pl.next")}
                </button>
              )}
            </div>
          </div>
        </div>
        {queueList}
        {queue.length ? (
          <p className="gc-fine">
            {playing.player ? t("pl.queueFine", { name: playing.player }) : t("pl.queueFineAnon")}
          </p>
        ) : null}
        {me.next && !pc.mine ? (
          <>
            <p className="pl-k">{t("pl.pick")}</p>
            {tiles((g) => {
              setPicked(g.appid);
              void apply(queueNext(crew.id, g.appid));
            }, choice)}
          </>
        ) : null}
      </div>
    );
  }

  if (playing) {
    return (
      <div className="pl" data-play="you">
        <h2>{t("pl.youH", { game: nameOf(playing.gameId) })}</h2>
        {queueList}
      </div>
    );
  }

  if (pc.state !== "ready") {
    return (
      <div className="pl" data-play="claimed">
        <h2>{t("pl.claimedH", { pc: pcName })}</h2>
        <p className="gc-p">{t("pl.claimedP")}</p>
        {queueList}
      </div>
    );
  }

  if (pc.mine) {
    return (
      <div className="pl" data-play="own">
        <h2>{t("pl.freeH")}</h2>
        <p className="gc-p">{t("pl.ownFree")}</p>
        {queueList}
      </div>
    );
  }

  const owner = pc.owner;
  return (
    <div className="pl" data-play="free">
      <h2>{t("pl.freeH")}</h2>
      <p className="gc-p">{t("pl.freeP", { pc: pcName })}</p>
      {queueList}
      <p className="pl-k">{t("pl.yours", { pc: pcName })}</p>
      {tiles((g) => setPicked(g.appid), choice)}
      {choice ? (
        <div className="gc-go">
          <button type="button" className="lpill solid" disabled={busy || phase !== "idle"} onClick={start}>
            {t("pl.start", { game: choice.title })}
            <span className="lpill-c">
              <Glyph name="play" size={18} />
            </span>
          </button>
          <p className="gc-fine">{owner ? t("pl.fine", { owner }) : t("pl.fineMine")}</p>
        </div>
      ) : null}
      {failed ? <p role="alert">{t("pl.failed")}</p> : null}
    </div>
  );
}
