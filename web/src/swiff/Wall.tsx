import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Backdrop, Button, EmptyState } from "@swiff/ui";
import type { Game, Machine, Spot } from "./data";
import { fmtLeft, leftAt, readyFor, wallOrder } from "./derive";
import { Glyph } from "./Glyph";
import { ResumeFace, TimeMark } from "./instruments";
import { CrewsCard, CrewStrip } from "./CrewsCard";
import { useScreenText, type ScreenKey, type ScreenText } from "./screenCopy";
import { CrewLiveBand } from "./Crew";
import { SignInWithSteam } from "./SignIn";
import { gameArt, gameArtFallbacks, gamePreview, libraryState, type LibraryState } from "./steam";
import type { Swiff } from "./useSwiff";
import { paidGaming } from "./features";

/** The hero and one ruled row of four under it; the rest wait behind "All games". */
const LIMIT = 5;

/** Signed out, the hero shows this many playable games in turn, each for ROTATE_MS. */
const ROTATE_COUNT = 4;
const ROTATE_MS = 7000;

/** How long the pointer has to rest on a tile before its trailer starts. */
const PREVIEW_DELAY_MS = 380;

/**
 * The hovered tile, once the pointer has stayed on it for a moment. Sweeping
 * across the wall should not start (and download) a trailer per tile passed.
 */
function usePreview(hoverId: string | null): string | null {
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    if (hoverId === null) {
      setPreviewId(null);
      return;
    }
    const timer = window.setTimeout(() => setPreviewId(hoverId), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hoverId]);
  return previewId;
}

const REDUCE = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const list = window.matchMedia?.(REDUCE);
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

const reducedNow = () => window.matchMedia?.(REDUCE).matches ?? false;

/** Whether the OS asks for less motion, kept current as the setting changes. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, reducedNow, () => false);
}

/**
 * Which of `count` hero games is up. It moves on every ROTATE_MS while motion
 * is on, the OS has not asked for less of it, and nothing has paused it: a
 * pointer over the hero or focus inside it holds the current game. `last` is
 * the game before it, the one fading out.
 */
function useRotation(count: number, motion: boolean) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const hold = (by: "pointer" | "focus", on: boolean) => setHeld((h) => ({ ...h, [by]: on }));
  const reduced = useReducedMotion();
  const turning = count > 1 && motion && !reduced && !held.pointer && !held.focus;
  useEffect(() => {
    if (!turning) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [turning, count]);
  // A shorter list (the wall changed under it) must not leave the index past its end.
  const at = index < count ? index : 0;
  return { index: at, last: (at + count - 1) % count, hold };
}

/** "4 h 30" or "12 h+": the time a machine stays free from `now` (Unix ms), as the band prints it. */
const leftLabel = (t: ScreenText, machine: Machine, now: number) => {
  const left = fmtLeft(leftAt(machine, now));
  return left === "12 h+" ? t("wall.openEnd") : left;
};

/** "4 h 30 free" under Resume, or just "12 h+". */
const heroLeft = (t: ScreenText, machine: Machine, now: number) => {
  const left = leftLabel(t, machine, now);
  return left === t("wall.openEnd") ? left : t("hero.left", { left });
};

/** "free until 00:30", or "free for 12 h+" for a machine free that long or with no end set. */
const untilLabel = (t: ScreenText, machine: Machine) =>
  machine.until === "late" ? t("wall.freeOpenEnd") : t("wall.freeUntil", { at: machine.until });

/** Why a game cannot start now: who comes back and when, or why nothing will. */
function waitLabel(t: ScreenText, spot: Spot | undefined): string {
  if (spot?.back) return t("wall.backAt", { at: spot.back.at });
  if (spot?.free) return t("wall.freeShort");
  if (spot?.busy) return t("wall.inUse");
  return t("wall.noMachine");
}

/** Of these games' spots, the one whose busy machine is back soonest; none when no machine says. */
function soonestBack(spots: (Spot | undefined)[]): Spot | undefined {
  return spots
    .filter((s): s is Spot & { back: NonNullable<Spot["back"]> } => Boolean(s?.back))
    .sort((a, b) => a.back.backAt - b.back.backAt)[0];
}

/**
 * Why nothing on the wall is ready, from the host schedule: who comes back
 * first and when, or that what is free does not last the session, or that
 * nothing is on offer at all.
 */
function emptyLine(t: ScreenText, games: Game[], spots: ReadonlyMap<string, Spot>): string {
  const known = games.flatMap((g) => spots.get(g.id) ?? []);
  const back = soonestBack(known)?.back;
  if (back) return t("wall.emptyBack", { name: back.name, at: back.at });
  if (known.some((s) => s.free)) return t("wall.emptyShort");
  if (known.some((s) => s.busy)) return t("wall.emptyBusy");
  return t("wall.emptyNone");
}

/** A game that just became playable pulses, unless motion is off. */
const freedClass = (swiff: Swiff, game: Game) => (swiff.motion && swiff.freed.has(game.id) ? " freed" : "");

export function Wall({ swiff }: { swiff: Swiff }) {
  const { games, spots, signedIn, showAll } = swiff;
  const { t } = useScreenText();
  const paid = paidGaming();
  // Crews only (paid gaming off): the wall is where a crew picks a game, never
  // a stranger's start page, which is the server's at "/".
  const away = !paid && swiff.signInKnown && !signedIn && !swiff.demo;
  useEffect(() => {
    if (away) location.replace("/");
  }, [away]);

  const ordered = useMemo(() => wallOrder(games, spots), [games, spots]);
  // Nothing is ready only once something is known: signed out, nothing ever is,
  // and signed in, nothing is until the server has answered.
  const known = ordered.some((g) => spots.has(g.id));
  const anythingFree = !known || ordered.some((g) => readyFor(spots, g) > 0);

  // Before sign-in the wall leads with a free-to-play title: the one game a
  // stranger can play the moment they sign in, whatever they own.
  const wall = useMemo(() => {
    const shown = showAll ? ordered : ordered.slice(0, LIMIT);
    if (signedIn) return shown;
    return [...shown].sort((a, b) => Number(Boolean(b.f2p)) - Number(Boolean(a.f2p)));
  }, [ordered, showAll, signedIn]);

  const previewId = usePreview(swiff.hoverId);

  const library = swiff.profile ? libraryState(swiff.profile) : "ok";
  const note =
    library === "ok" ? null : (
      <LibraryNote t={t} state={library} retrying={swiff.libraryRetrying} onRetry={swiff.retryLibrary} />
    );

  // A renter with nothing to show still needs to hear why, not "everything is busy".
  if (!games.length && note)
    return (
      <main className="wall wall-bare" data-testid="wall">
        {note}
      </main>
    );
  // Nothing free is said only on the paid marketplace: a crew sees its games either way.
  if (!anythingFree && paid)
    return (
      <WallEmpty
        t={t}
        note={note}
        signedIn={signedIn}
        swiff={swiff}
        state={emptyLine(t, ordered, spots)}
        crew={<CrewLiveBand swiff={swiff} />}
      />
    );

  const [hero, ...rest] = wall;
  // Signed out, the hero turns through a few games: ones free right now in the
  // demo, else the free-to-play ones, since signed out nothing says what is
  // free. Signed in it stays on the renter's own lead game.
  const showcase = signedIn
    ? []
    : wall.filter((g) => (spots.has(g.id) ? readyFor(spots, g) > 0 : Boolean(g.f2p))).slice(0, ROTATE_COUNT);
  const busy = ordered.filter((g) => spots.has(g.id) && !readyFor(spots, g));
  const more = !showAll && ordered.length > LIMIT;

  return (
    <main className="wall" data-testid="wall">
      {hero ? <WallHero t={t} games={showcase.length ? showcase : [hero]} swiff={swiff} /> : null}

      <section className="band" aria-label={t("wall.games")}>
        {note}
        <CrewLiveBand swiff={swiff} />
        {signedIn && !swiff.demo ? <CrewStrip swiff={swiff} /> : null}
        <div className="band-tabs">
          {signedIn && library === "ok" ? (
            <>
              <BandTab on label={t("wall.library")} n={ordered.length} />
              <BandTab label={t("wall.f2p")} n={ordered.filter((g) => g.f2p).length} />
              <BandTab label={t("wall.readyNow")} n={ordered.length - busy.length} />
            </>
          ) : signedIn ? (
            // Nothing of their own to show: the wall is free-to-play only, and says so.
            <>
              <BandTab on label={t("wall.f2p")} n={ordered.length} />
              <BandTab label={t("wall.readyNow")} n={ordered.length - busy.length} />
              <BandTab label={t("wall.library")} n={0} />
            </>
          ) : (
            <>
              <BandTab on label={t("wall.f2p")} n={ordered.filter((g) => g.f2p).length} />
              <BandTab label={t("wall.popular")} n={ordered.length} />
              <span className="band-tab">
                <span>{t("wall.library")}</span>
                <Glyph name="lock" size={16} />
              </span>
            </>
          )}
          {more ? (
            <button type="button" className="band-tab" onClick={() => swiff.setShowAll(true)}>
              <span>{t("wall.allGames", { n: ordered.length })}</span>
              <Glyph name="arrow" size={16} />
            </button>
          ) : busy.length ? (
            <BandTab
              label={waitLabel(t, soonestBack(busy.map((g) => spots.get(g.id))) ?? spots.get(busy[0]!.id))}
              n={busy.length}
            />
          ) : (
            <span className="band-tab" />
          )}
        </div>

        <div className="band-tiles">
          {rest.map((game) => (
            <BandTile
              key={game.id}
              t={t}
              game={game}
              preview={previewId === game.id}
              swiff={swiff}
              signedIn={signedIn}
            />
          ))}
        </div>

        <footer className="band-foot mono">
          {swiff.steamDenied ? <p className="band-denied">{t("wall.denied")}</p> : null}
          <p>{t("wall.artCredit")}</p>
        </footer>
      </section>
    </main>
  );
}

function BandTab({ label, n, on }: { label: string; n: number; on?: boolean }) {
  return (
    <span className={on ? "band-tab on" : "band-tab"}>
      <span>{label}</span>
      <span className="band-n">{n}</span>
    </span>
  );
}

/**
 * Shrink a title until it fits its box in at most two lines: any game's name,
 * from "Hades" to "Counter-Strike 2", sets as large as its box allows. The box
 * comes from CSS (max-width), so this only ever steps the size down from the
 * CSS size, and measures again when the box or the font changes.
 */
function useFitTitle(text: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize);
      const tooBig = () => el.scrollWidth > el.clientWidth + 1 || el.offsetHeight > 2 * size * 1.08;
      while (size > 20 && tooBig()) {
        size -= 2;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    const box = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    box?.observe(el.closest(".hero-3b-art") ?? el);
    void document.fonts?.ready.then(fit);
    return () => box?.disconnect();
  }, [text]);
  return ref;
}

/**
 * The wall's lead game, hero 3b "Drafted title": the art shown whole with the
 * name drafted bottom left between cap and base lines and a tick ruler along
 * the art's foot, all tied to the frame, never to anything in the picture.
 * Everything to read or press sits in the grey strip under the art: the line,
 * the machine (signed in) or the pitch (signed out), and Resume or the one
 * Sign in with Steam.
 */
function WallHero({ t, games, swiff }: { t: ScreenText; games: Game[]; swiff: Swiff }) {
  const { signedIn, clock } = swiff;
  const at = useRotation(games.length, swiff.motion);
  const game = games[at.index] ?? games[0]!;
  const spot = swiff.spots.get(game.id);
  const best = spot?.best ?? null;
  const title = useFitTitle(game.title);
  const leader = !signedIn ? t("hero.leaderOut") : game.owned ? t("hero.fromLibrary") : t("wall.f2p");
  // What the renter has of this game, worded here rather than taken from the card, so it speaks the wall's language.
  const kick = !game.owned
    ? t("wall.f2p")
    : game.hours
      ? t("hero.played", { n: game.hours })
      : t("hero.inLibrary");

  return (
    <section
      className={`hero-3b${freedClass(swiff, game)}`}
      data-testid="hero"
      onMouseEnter={() => {
        swiff.setHoverId(null);
        at.hold("pointer", true);
      }}
      onMouseLeave={() => at.hold("pointer", false)}
      onFocus={() => at.hold("focus", true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) at.hold("focus", false);
      }}
    >
      <div className="hero-3b-art">
        {/* Every game in the turn is painted, so the next image is loaded before
            it fades in; only the current one is opaque, and only it and the one
            fading out drift. */}
        {games.map((g, i) => (
          <Backdrop
            key={g.id}
            className={i === at.index ? "hero-slide on" : "hero-slide"}
            aria-hidden={i === at.index ? undefined : true}
            image={gameArt(g, 2)}
            fallback={gameArtFallbacks(g)}
            position={g.focus}
            drift={i === at.index || i === at.last}
          />
        ))}
        <div className="hero-3b-scrim" />
        <div className="hero-3b-ruler" aria-hidden="true" />
        {/* Keyed by game, so the drafted title fades in with its art. */}
        <div className="hero-3b-draft hero-turn" key={game.id}>
          <div className="mono hero-3b-leader">{leader}</div>
          <div className="hero-3b-dline">
            <span className="hero-3b-rule hero-3b-cap" aria-hidden="true" />
            <h1 className="hero-3b-title" ref={title}>
              {game.title}
            </h1>
            <span className="hero-3b-rule hero-3b-base" aria-hidden="true" />
          </div>
        </div>
      </div>

      {signedIn ? (
        <div className="hero-strip">
          <div className="hero-strip-cell hero-strip-say">
            <div className="mono hero-strip-kick">{kick}</div>
            <p className="hero-strip-line">
              {best ? (
                <>
                  {t("hero.on")} <b>{best.name}</b>, {untilLabel(t, best)}
                </>
              ) : spot ? (
                waitLabel(t, spot)
              ) : (
                t("hero.finding")
              )}
            </p>
          </div>
          <div className="hero-strip-cell hero-strip-facts">
            {best ? (
              <dl className="hero-kv mono">
                <dt>{t("hero.on")}</dt>
                <dd>{best.name}</dd>
                <dt>{t("hero.gpu")}</dt>
                <dd>{best.gpu}</dd>
                <dt>{t("hero.response")}</dt>
                <dd>{best.ping} ms</dd>
                <dt>{best.until === "late" ? t("hero.freeFor") : t("hero.freeUntil")}</dt>
                <dd>{best.until === "late" ? t("wall.openEnd") : best.until}</dd>
              </dl>
            ) : null}
          </div>
          <div className="hero-strip-cell hero-strip-act">
            <button
              type="button"
              className="resume"
              onClick={() => swiff.openGame(game)}
              aria-describedby={best ? "hero-left" : undefined}
            >
              <ResumeFace />
              <span className="resume-label">
                <Glyph name="play" size={20} />
                {game.owned ? t("hero.resume") : t("hero.play")}
                {best ? (
                  <small id="hero-left" aria-hidden="true">
                    {heroLeft(t, best, clock)}
                  </small>
                ) : null}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="hero-strip hero-strip-out">
          <div className="hero-strip-cell hero-strip-say">
            <div className="mono hero-strip-kick">
              <span className="live-dot" />
              {t("hero.kickOut")}
            </div>
            <p className="hero-strip-line hero-turn" key={game.id}>
              {best ? t("hero.onGpu") : t("hero.onShared")}{" "}
              <b>{best ? best.gpu.replace(/^(RTX|RX) /, "") : t("hero.sharedPc")}</b>.{" "}
              <b>{t("hero.noDownload")}</b>
            </p>
          </div>
          <div className="hero-strip-cell hero-strip-facts">
            <p className="hero-strip-pitch">{t("hero.pitch")}</p>
          </div>
          <div className="hero-strip-cell hero-strip-act">
            <SignInWithSteam label={t("signIn.steam")} />
            <span className="mono hero-strip-fine">{t("hero.fine")}</span>
          </div>
        </div>
      )}
    </section>
  );
}

type TileProps = {
  t: ScreenText;
  game: Game;
  /** The pointer has rested on this tile: play its trailer. */
  preview: boolean;
  swiff: Swiff;
  signedIn: boolean;
};

/** One game in the ruled band: art flush in its cell, the title, and where it would run. */
function BandTile({ t, game, preview, swiff, signedIn }: TileProps) {
  const spot = swiff.spots.get(game.id);
  const best = spot?.best ?? null;
  const signInFirst = !signedIn && !game.f2p;
  // Locked when it cannot start: sign-in stands in the way, or the machines
  // are known and none is ready. Nothing known yet locks nothing.
  const waiting = spot !== undefined && !best;
  const locked = signInFirst || waiting;

  let meta: ReactNode;
  if (signInFirst) meta = <span>{t("tile.signInOwn")}</span>;
  else if (waiting) meta = <span>{waitLabel(t, spot)}</span>;
  else if (best)
    meta = (
      <>
        <span>{best.name}</span>
        <span className="band-tile-left">
          <TimeMark minutes={leftAt(best, swiff.clock)} />
          {leftLabel(t, best, swiff.clock)}
        </span>
      </>
    );
  // Signed out nothing is shown about machines; signed in they are on their way.
  else meta = <span>{signedIn ? t("tile.finding") : t("tile.signIn")}</span>;

  return (
    <button
      type="button"
      className={`${locked ? "band-tile band-tile-locked" : "band-tile"}${freedClass(swiff, game)}`}
      onClick={() => swiff.openGame(game)}
      onMouseEnter={() => swiff.setHoverId(game.id)}
      onMouseLeave={() => swiff.setHoverId(null)}
    >
      <span className="band-tile-frame">
        <Backdrop
          className="band-tile-art"
          image={gameArt(game, 1)}
          fallback={gameArtFallbacks(game)}
          // A tile moves only once it is being looked at, and only if it can be played.
          video={!locked && preview ? gamePreview(game) : null}
          position={game.focus}
        />
        {locked ? (
          <span className="band-tile-lock">
            <Glyph name={signInFirst ? "lock" : "clock"} size={20} />
          </span>
        ) : null}
      </span>
      <span className="band-tile-title">
        <span>{game.title}</span>
        {/* Free-to-play is marked wherever it is not one of your own games. */}
        {game.f2p && (!signedIn || !game.owned) ? <span className="free-mark">{t("tile.free")}</span> : null}
      </span>
      <span className="band-tile-meta mono">{meta}</span>
    </button>
  );
}

const LIBRARY_COPY = {
  unreadable: { title: "library.unreadable", body: "library.unreadableBody" },
  checking: { title: "library.checking", body: "library.checkingBody" },
  none: { title: "library.none", body: "library.noneBody" },
} as const satisfies Record<Exclude<LibraryState, "ok">, { title: ScreenKey; body: ScreenKey }>;

/**
 * Why a signed-in renter sees none of their own games. Only free-to-play games
 * are shown beside it. An unreadable library, and one still being checked, also
 * get a button that reads it again; a checked one would read the same, so it
 * gets none.
 */
function LibraryNote({
  t,
  state,
  retrying,
  onRetry,
}: {
  t: ScreenText;
  state: Exclude<LibraryState, "ok">;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { title, body } = LIBRARY_COPY[state];
  return (
    <div className="library-note" role="status" data-testid="library-state">
      <p>
        <strong>{t(title)}</strong> {t(body)}
      </p>
      {state === "unreadable" || state === "checking" ? (
        <button type="button" className="lpill lpill-sm" onClick={onRetry} disabled={retrying}>
          {retrying
            ? t("library.retrying")
            : state === "checking"
              ? t("library.checkAgain")
              : t("library.retry")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * No shared machine is ready; a library note, when there is one, still leads.
 * `state` says why (emptyLine). Signed out (the demo), the way in is still the
 * one Sign in with Steam.
 */
function WallEmpty({
  t,
  note,
  signedIn,
  swiff,
  state,
  crew,
}: {
  t: ScreenText;
  /** Crewmates playing now: watching one is something to do while nothing is free. */
  crew?: ReactNode;
  note?: ReactNode;
  signedIn: boolean;
  swiff: Swiff;
  state: string;
}) {
  return (
    <main className="wall wall-bare" data-testid="wall">
      {note}
      {crew}
      <EmptyState
        title={t("empty.title")}
        body={signedIn ? t("empty.signedIn", { state }) : t("empty.signedOut", { state })}
        action={
          signedIn ? <Button>{t("empty.notify")}</Button> : <SignInWithSteam label={t("signIn.steam")} />
        }
      />
      {/* A gaming PC in the player's crew is the way to play when none is free. */}
      {signedIn ? <CrewsCard swiff={swiff} /> : null}
    </main>
  );
}
