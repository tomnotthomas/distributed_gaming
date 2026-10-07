// The crew pages (/crews): the crews a player is in, founding one in a tap
// right there, and one crew's page (/crews/<id>), in the approved
// guided "ticket" design: the crew's next Zockrunde is a ticket with one
// coupon per step, and only the step to do now is open, with one main button.
// Done steps shrink to a line with a tick and "change"; later ones are only
// names; renaming, the crew link and leaving sit folded at the bottom. The
// founder sets the date, sends it out, gets a gaming PC in and plays; someone
// who joined says yes or no, gets a gaming PC in and plays. Every step is read
// from the crew itself, and the page reads it again whenever the event stream
// says something changed, so an answer or a PC arriving shows at once.

import { useCallback, useEffect, useRef, useState } from "react";
import { STEAM_LOGIN_URL } from "./steam";
import {
  activeSession,
  answerCrewSession,
  bringPc,
  createCrew,
  crewTitle,
  fetchCrew,
  fetchCrews,
  inviteMessage,
  pcTitle,
  removeCrewMember,
  renameCrew,
  renewCrewLink,
  sessionClock,
  sessionDay,
  sessionTime,
  sessionWeekday,
  sharedCrew,
  takeLanding,
  takePcFirst,
  FOUND_PATH,
  type CrewDetail,
  type CrewMember,
  type MyCrew,
} from "./crews";
import { crewText, type CopyKey, type Lang } from "./crewCopy";
import { DateStep, GamesStep, WhoIsComing } from "./CrewPlan";
import { CrewPlay, playPc } from "./CrewPlay";
import { Avatar, LobbyArt, LobbyTitle, PcIcon, Tick, useCrewText, useShare, WhatsAppGlyph } from "./crewUi";
import { Glyph } from "./Glyph";
import { inviteLink } from "./invite";
import { HOST_DOWNLOAD_URL } from "./SharePC";
import type { Swiff } from "./useSwiff";

/** The crew pages, by their address. */
export function CrewPage({ swiff }: { swiff: Swiff }) {
  const { crewRoute, signedIn, signInKnown } = swiff;
  if (!signInKnown) return <CrewLoading />;
  if (!signedIn) return <FoundSignedOut />;
  if (crewRoute.crew) return <Lobby key={crewRoute.crew} id={crewRoute.crew} swiff={swiff} />;
  return <CrewList swiff={swiff} />;
}

function CrewLoading() {
  const { t } = useCrewText();
  return (
    <main className="crew-lobby" data-testid="crew" aria-busy="true">
      <p className="lb-wrap crew-wait">{t("crew.loading")}</p>
    </main>
  );
}

/** Founding a crew, signed out: what a crew is, and Steam sign-in that comes back to found it. */
function FoundSignedOut() {
  const { t } = useCrewText();
  return (
    <main className="crew-lobby" data-testid="crew">
      <section className="lb-lobby">
        <LobbyArt />
        <div className="lb-wrap lb-in">
          <div>
            <LobbyTitle prose>{t("found.title")}</LobbyTitle>
            <p className="fa-why">{t("found.line")}</p>
            <p className="fa-why">{t("found.why")}</p>
            <div className="lb-join">
              <a className="lpill solid" href={`${STEAM_LOGIN_URL}?to=${encodeURIComponent(FOUND_PATH)}`}>
                {t("found.start")}
                <span className="lpill-c">
                  <Glyph name="arrow" size={18} />
                </span>
              </a>
              <p>{t("found.signIn")}</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * /crews: the crews the player is in, and founding another, which opens its
 * lobby at once. One crew opens straight away.
 */
function CrewList({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const [crews, setCrews] = useState<MyCrew[] | "failed" | null>(null);
  // From a "Crew gründen" button: a player with no crew yet gets one at once;
  // from the app's "Start a new crew", any player does.
  const [landing] = useState(takeLanding);
  const [founding, setFounding] = useState(false);
  const [foundFailed, setFoundFailed] = useState<"full" | boolean>(false);
  const foundedOnce = useRef(false);
  const { openCrew, replaceCrew } = swiff;

  const load = useCallback(() => {
    setCrews(null);
    void fetchCrews().then((answer) => setCrews(answer ?? "failed"));
  }, []);
  useEffect(load, [load]);

  const found = useCallback(() => {
    setFounding(true);
    setFoundFailed(false);
    void createCrew().then((crew) => {
      setFounding(false);
      if (crew === "full") setFoundFailed("full");
      else if (crew) replaceCrew(crew.id);
      else setFoundFailed(true);
    });
  }, [replaceCrew]);

  useEffect(() => {
    if (!Array.isArray(crews)) return;
    // Once per visit: a page that re-renders never founds a second crew.
    if (landing.found === "new" || (landing.found === "first" && !crews.length)) {
      if (foundedOnce.current) return;
      foundedOnce.current = true;
      found();
    } else if (crews.length === 1) replaceCrew(crews[0]!.id);
  }, [crews, replaceCrew, landing, found]);

  return (
    <main className="crew-lobby" data-testid="crew">
      <section className="lb-lobby">
        <LobbyArt />
        <div className="lb-wrap lb-in">
          <div>
            <LobbyTitle prose>
              {Array.isArray(crews) && crews.length ? t("crews.title") : t("found.title")}
            </LobbyTitle>
            {crews === null || founding ? (
              <p className="fa-why" aria-busy="true">
                {t(founding ? "crew.loading" : "crews.loading")}
              </p>
            ) : crews === "failed" ? (
              <div role="alert" className="crew-gone">
                <p>{t("crews.failed")}</p>
                <button type="button" className="lpill" onClick={load}>
                  {t("crews.retry")}
                </button>
              </div>
            ) : crews.length ? (
              <ul className="crew-list">
                {crews.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="lb-slot act crew-pick" onClick={() => openCrew(c.id)}>
                      <span className="lb-who">
                        <span className="lb-name">{crewTitle(lang, c)}</span>
                        <span className="lb-meta">
                          {c.size === 1 ? t("crews.person") : t("crews.people", { n: c.size })} ·{" "}
                          {t(
                            c.state === "ready"
                              ? "cp.ready"
                              : c.state === "offline"
                                ? "cp.offline"
                                : "cp.almost",
                          )}
                        </span>
                      </span>
                      <span className="lchip free">{t("crews.open")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="fa-why">{t("found.line")}</p>
                <p className="fa-why">{t("found.why")}</p>
              </>
            )}
            {foundFailed ? (
              <p role="alert" className="crew-gone">
                {t(foundFailed === "full" ? "crews.full" : "found.failed")}
              </p>
            ) : null}
            {Array.isArray(crews) ? (
              <div className="lb-join">
                <button type="button" className="lpill solid" disabled={founding} onClick={found}>
                  {crews.length ? t("crews.new") : t("found.start")}
                  <span className="lpill-c">
                    <Glyph name="arrow" size={18} />
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

/** A step on the way to the Zockrunde, as the crew page's ticket shows it. */
type StepId = "date" | "people" | "answer" | "pc" | "games" | "play";
type Step = { id: StepId; label: CopyKey; done: boolean; value?: string; change?: boolean };

/**
 * The steps to the crew's Zockrunde for whoever looks, from the crew as it is:
 * its admin sets the date, sends it out, gets a gaming PC in, picks games and
 * plays; someone who joined says yes or no, gets a gaming PC in, picks games
 * and plays. A step that cannot be done yet (answering before there is a date,
 * picking games before there is a date and a PC) is never the current one. Picking stays
 * open while the viewer is at it (`picking`), and is done once they marked a
 * game or said they are done (`picked`), or when the PCs in have none to pick.
 */
export function crewSteps(
  crew: CrewDetail,
  me: CrewMember,
  now: number,
  lang: Lang,
  { picking = false, picked = false } = {},
): Step[] {
  const t = crewText(lang);
  const session = activeSession(crew, now);
  const games: Step = {
    id: "games",
    label: "g.stepGames",
    done: !picking && (crew.picks > 0 || picked || (session !== null && crew.pcs > 0 && crew.offered === 0)),
    value: crew.picks ? t(crew.picks === 1 ? "g.pickedOne" : "g.picked", { n: crew.picks }) : undefined,
    change: crew.pcs > 0,
  };
  const pc: Step = {
    id: "pc",
    label: "g.stepPc",
    done: crew.pcs > 0,
    value: crew.machines[0] ? pcTitle(lang, crew.machines[0]) : undefined,
  };
  const play: Step = { id: "play", label: "g.stepPlay", done: false };
  if (crew.own) {
    return [
      {
        id: "date",
        label: "g.stepDate",
        done: session !== null,
        value: session ? `${sessionDay(lang, session.at)}, ${sessionTime(lang, session.at)}` : undefined,
        change: true,
      },
      {
        id: "people",
        label: "g.stepPeople",
        done: session !== null && crew.shared,
        value: t("g.inCrew", { n: crew.size }),
        change: true,
      },
      pc,
      games,
      play,
    ];
  }
  return [
    {
      id: "answer",
      label: "g.stepAnswer",
      done: session !== null && me.rsvp !== null,
      value: me.rsvp ? t(me.rsvp === "yes" ? "g.ansYes" : "g.ansNo") : undefined,
      change: true,
    },
    pc,
    games,
    play,
  ];
}

/** The step to do now: the first one not done that can be done. */
function currentStep(steps: Step[], crew: CrewDetail, now: number): StepId {
  const session = activeSession(crew, now);
  const step = steps.find(
    (s) =>
      !s.done &&
      (s.id !== "answer" || session) &&
      (s.id !== "people" || session) &&
      (s.id !== "games" || (session && crew.pcs > 0)),
  );
  return step?.id ?? "play";
}

/** One crew's page: the next Zockrunde as a ticket, with the one step to do now open on it. */
function Lobby({ id, swiff }: { id: string; swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const [crew, setCrew] = useState<CrewDetail | "gone" | "failed" | null>(null);
  // A done step opened again ("change"); from the host side of the marketing site, the PC step.
  const [open, setOpen] = useState<StepId | null>(() => (takePcFirst() ? "pc" : null));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Asked the group for a gaming PC: the PC step waits for one.
  const [asked, setAsked] = useState(false);
  // At the games, marking: the step stays open until they say they are done, which `picked` keeps.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(false);
  const { note, say, share, copyLink } = useShare(swiff.inviteShared);
  const { crewChanges, crewReady, dismissCrewReady, openCrew } = swiff;
  const ticketRef = useRef<HTMLElement>(null);

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setCrew(null);
      void fetchCrew(id).then((answer) => {
        if (answer) setCrew(answer);
        else if (!quiet) setCrew("failed");
      });
    },
    [id],
  );
  useEffect(() => load(), [load]);
  // Something changed somewhere (a PC came, went or got busy, someone joined or answered): read the crew again.
  const firstChange = useRef(crewChanges);
  useEffect(() => {
    if (crewChanges !== firstChange.current) load(true);
  }, [crewChanges, load]);

  const ready = crewReady === id;
  useEffect(() => {
    if (ready) load(true);
  }, [ready, load]);

  if (crew === null) return <CrewLoading />;
  if (crew === "gone" || crew === "failed") {
    return (
      <main className="crew-lobby" data-testid="crew">
        <div className="lb-wrap crew-wait crew-gone" role="alert">
          <h1>{t(crew === "gone" ? "gone.title" : "crew.failed")}</h1>
          {crew === "gone" ? <p>{t("gone.line")}</p> : null}
          <div className="fa-acts">
            {crew === "failed" ? (
              <button type="button" className="lpill solid" onClick={() => load()}>
                {t("crews.retry")}
              </button>
            ) : null}
            <button type="button" className="lpill" onClick={() => openCrew()}>
              {t("gone.back")}
            </button>
          </div>
        </div>
      </main>
    );
  }

  const me = crew.members.find((m) => m.you)!;
  const admin = crew.members.find((m) => m.admin);
  const title = crewTitle(lang, crew);
  const link = crew.token ? inviteLink(crew.token) : "";
  const now = Date.now();
  const message = inviteMessage(lang, crew, location.origin, now);
  const firstPc = crew.machines.find((m) => m.state !== "offline") ?? crew.machines[0];
  const pcName = firstPc ? pcTitle(lang, firstPc) : "";
  const session = activeSession(crew, now);
  const steps = crewSteps(crew, me, now, lang, { picking, picked });
  const current = open && steps.some((s) => s.id === open) ? open : currentStep(steps, crew, now);
  const answers = crew.members.filter((m) => m.rsvp === "yes");
  const unanswered = crew.size - (session ? session.yes + session.no : 0);

  const apply = async (work: Promise<CrewDetail | null>) => {
    setBusy(true);
    const next = await work;
    setBusy(false);
    if (next) {
      setCrew(next);
      setOpen(null);
      ticketRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    } else say(t("toast.failed"));
    return next;
  };

  // The invite goes out with the date: the "get your people" step is done.
  const sendInvite = async () => {
    if (await share("whatsapp", message, link, "toast.sent")) await apply(sharedCrew(id));
  };
  const copyInvite = async () => {
    if (await copyLink(link)) await apply(sharedCrew(id));
  };

  // One click: the Lanterel app downloads (once a release is published), and
  // their PC plays for the crew from now on, once it runs the app.
  const bringMine = async () => {
    if (HOST_DOWNLOAD_URL) startDownload(HOST_DOWNLOAD_URL);
    await apply(bringPc(id, "yes"));
  };
  const askGroup = async () => {
    await share("whatsapp", message, link, "toast.asked");
    setAsked(true);
  };

  const saveName = async () => {
    if (renaming === null) return;
    if (await apply(renameCrew(id, renaming))) {
      setRenaming(null);
      say(t("toast.renamed"));
    }
  };

  const leave = async () => {
    setBusy(true);
    const done = await removeCrewMember(me.id);
    setBusy(false);
    if (done) openCrew();
    else say(t("toast.failed"));
  };

  return (
    <main className="crew-lobby gc" data-testid="crew" data-state={crew.state} data-step={current}>
      {ready ? (
        <div className="crew-ready" role="status">
          <span className="crew-rays" aria-hidden="true" />
          <b>{t("ready.title", { pc: pcName || t("pc.anon") })}</b>
          <button type="button" className="lpill" onClick={dismissCrewReady}>
            {t("ready.close")}
          </button>
        </div>
      ) : null}

      <section className="lb-lobby" aria-labelledby="lb-h1">
        <LobbyArt />
        <div className="gc-wrap">
          <div className="gc-crew">
            <h1 id="lb-h1" className="gc-name crew-name">
              {title}
            </h1>
            {crew.machines.some((m) => m.playing) ? <span className="pl-live">{t("pl.onNow")}</span> : null}
            <span className="gc-whose">
              {crew.own
                ? t("g.founded")
                : admin?.name
                  ? t("g.invitedBy", { name: admin.name })
                  : t("g.invited")}
            </span>
          </div>

          <section className="gc-tk" aria-labelledby="gc-date" ref={ticketRef}>
            <div className="gc-head">
              <h2 className={session ? "gc-date" : "gc-date none"} id="gc-date">
                <span className="gc-pre">{t("g.session")}</span>
                {session ? (
                  <>
                    <span>{sessionDay(lang, session.at)}</span>{" "}
                    <span className="gc-time">{sessionClock(session.at)}</span>
                  </>
                ) : (
                  <span>{t("g.noDate")}</span>
                )}
              </h2>
              {session ? (
                <div className="gc-going">
                  <span className="gc-stack" aria-hidden="true">
                    {answers.slice(0, 4).map((m) => (
                      <Avatar key={m.id} name={m.name ?? t("cp.anon")} index={0} />
                    ))}
                  </span>
                  <p>
                    {crew.size === 1 ? (
                      <b>{t("g.onlyYou")}</b>
                    ) : (
                      <>
                        <b>{t("g.in", { n: session.yes })}</b>
                        <span>
                          {[
                            session.no ? t("g.cant", { n: session.no }) : null,
                            unanswered ? t("g.open", { n: unanswered }) : null,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              ) : null}
            </div>

            <ol className="gc-stubs" aria-label={t("g.steps")}>
              {steps.map((s) => {
                const state = s.id === current ? "now" : s.done ? "done" : "later";
                return (
                  <li
                    key={s.id}
                    className={`gc-stub ${state}`}
                    aria-current={state === "now" ? "step" : undefined}
                  >
                    <span className="gc-mark" aria-hidden="true">
                      <Tick />
                    </span>
                    <span className="gc-t">{t(s.label)}</span>
                    {state === "done" && s.value ? <span className="gc-v">{s.value}</span> : null}
                    {state === "done" && s.change ? (
                      <button
                        type="button"
                        className="gc-change"
                        aria-label={t("g.changeLabel", { step: t(s.label) })}
                        onClick={() => setOpen(s.id)}
                      >
                        {t("g.change")}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <div className="gc-cp" key={current}>
              {current === "date" ? (
                <DateStep
                  crew={crew}
                  over={crew.session !== null && session === null}
                  busy={busy}
                  apply={apply}
                />
              ) : current === "games" ? (
                <GamesStep
                  crewId={id}
                  members={crew.members}
                  session={session}
                  changes={crewChanges}
                  say={say}
                  onPick={() => setPicking(true)}
                  onDone={() => {
                    setPicking(false);
                    setPicked(true);
                    setOpen(null);
                    ticketRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                  }}
                />
              ) : current === "people" ? (
                <>
                  <h2>{t("g.peopleH")}</h2>
                  <p className="gc-p">{t("g.peopleP")}</p>
                  <div className="gc-split">
                    <div className="gc-acts gc-col">
                      <WhatsAppButton label={t("g.whatsapp")} onClick={() => void sendInvite()} />
                      <button
                        type="button"
                        className="gc-ghost"
                        disabled={!link}
                        onClick={() => void copyInvite()}
                      >
                        <LinkIcon />
                        {t("g.copy")}
                      </button>
                    </div>
                    <figure className="gc-msg">
                      <figcaption>{t("g.preview")}</figcaption>
                      <p className="gc-bubble">{message}</p>
                    </figure>
                  </div>
                </>
              ) : current === "answer" && session ? (
                <>
                  <h2>
                    {t("g.answerH", {
                      when: t("g.on", {
                        day: sessionWeekday(lang, session.at, "long"),
                        time: sessionTime(lang, session.at),
                      }),
                    })}
                  </h2>
                  <p className="gc-p">
                    {admin?.name ? t("g.answerP", { name: admin.name }) : t("g.answerPAnon")}
                  </p>
                  <div className="gc-acts">
                    <button
                      type="button"
                      className="lpill solid"
                      disabled={busy}
                      aria-pressed={me.rsvp === "yes"}
                      onClick={() => void apply(answerCrewSession(id, "yes"))}
                    >
                      {t("g.yes")}
                      <span className="lpill-c">
                        <Tick />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="gc-ghost"
                      disabled={busy}
                      aria-pressed={me.rsvp === "no"}
                      onClick={() => void apply(answerCrewSession(id, "no"))}
                    >
                      {t("g.no")}
                    </button>
                  </div>
                  <p className="gc-fine">{t("g.answerFine")}</p>
                </>
              ) : current === "pc" ? (
                me.pc === "yes" && crew.pcs === 0 ? (
                  <>
                    <h2>{t("cp.nextSetup")}</h2>
                    <p className="gc-p">{t("cp.nextSetupLine", { crew: title })}</p>
                    {HOST_DOWNLOAD_URL ? (
                      <div className="gc-acts">
                        <a className="lpill solid" href={HOST_DOWNLOAD_URL}>
                          {t("pcc.download")}
                          <span className="lpill-c">
                            <Glyph name="download" size={18} />
                          </span>
                        </a>
                      </div>
                    ) : (
                      <p className="gc-fine">{t("pcc.soon", { crew: title })}</p>
                    )}
                  </>
                ) : asked && crew.pcs === 0 ? (
                  <>
                    <h2>{t("g.pcWaitH")}</h2>
                    <p className="gc-p">{t("g.pcWaitP")}</p>
                    <div className="gc-acts">
                      <WhatsAppButton label={t("g.pcAsk")} onClick={() => void askGroup()} />
                      <button
                        type="button"
                        className="gc-ghost"
                        disabled={busy}
                        onClick={() => void bringMine()}
                      >
                        <PcIcon />
                        {t("g.pcHaveOne")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>{t("g.pcH")}</h2>
                    <p className="gc-p">{t("g.pcP")}</p>
                    <div className="gc-acts">
                      <button
                        type="button"
                        className="lpill solid"
                        disabled={busy}
                        onClick={() => void bringMine()}
                      >
                        {t("g.pcYes")}
                        <span className="lpill-c">
                          <Glyph name="download" size={18} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className="gc-ghost"
                        disabled={busy}
                        onClick={() => void askGroup()}
                      >
                        <WhatsAppGlyph />
                        {t("g.pcNo")}
                      </button>
                    </div>
                    {session ? <p className="gc-fine">{t("g.pcFine")}</p> : null}
                  </>
                )
              ) : crew.state === "ready" ? (
                <CrewPlay crew={crew} swiff={swiff} busy={busy} apply={apply} />
              ) : (
                <>
                  <h2>{t("cp.nextOffline")}</h2>
                  <p className="gc-p">
                    {crew.pcs > 1 ? t("cp.nextOfflineMany") : t("cp.nextOfflineLine", { pc: pcName })}
                  </p>
                </>
              )}
            </div>
          </section>
          <p className="cp-toast" role="status" aria-live="polite" hidden={!note}>
            {note}
          </p>
          {current === "play" && crew.state === "ready" && playPc(crew) ? (
            <p className="pl-pcline">
              <PcIcon />
              <span>{t("pl.pcLine", { pc: pcTitle(lang, playPc(crew)!) })}</span>
            </p>
          ) : null}

          {session && crew.size > 1 ? (
            <WhoIsComing
              crew={crew}
              session={session}
              share={share}
              onMove={
                crew.own
                  ? () => {
                      setOpen("date");
                      ticketRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                    }
                  : null
              }
            />
          ) : null}

          <details className="gc-more">
            <summary>
              {t("g.more")}
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div className="gc-more-b">
              {crew.own ? (
                renaming === null ? (
                  <button type="button" className="gc-ghost" onClick={() => setRenaming(crew.crewName ?? "")}>
                    {t("cp.rename")}
                  </button>
                ) : (
                  <form
                    className="crew-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveName();
                    }}
                  >
                    <input
                      className="name-in"
                      type="text"
                      maxLength={24}
                      autoFocus
                      value={renaming}
                      placeholder={t("cp.namePlaceholder")}
                      aria-label={t("cp.namePlaceholder")}
                      onChange={(event) => setRenaming(event.target.value)}
                    />
                    <button type="submit" className="name-edit" disabled={busy}>
                      {t("cp.save")}
                    </button>
                    <button type="button" className="name-edit" onClick={() => setRenaming(null)}>
                      {t("cp.cancel")}
                    </button>
                  </form>
                )
              ) : null}
              <button type="button" className="gc-ghost" disabled={!link} onClick={() => void copyLink(link)}>
                <LinkIcon />
                {t("g.copy")}
              </button>
              {crew.own ? (
                <button
                  type="button"
                  className="gc-ghost"
                  disabled={busy}
                  title={t("share.renewHint")}
                  onClick={() =>
                    void apply(renewCrewLink(id)).then((done) => done && say(t("toast.renewed")))
                  }
                >
                  {t("share.renew")}
                </button>
              ) : null}
              {leaving ? (
                <div className="crew-leave-ask" role="group" aria-labelledby="leave-h">
                  <h3 id="leave-h">{t("leave.title", { crew: title })}</h3>
                  <p>{t(me.pcs ? "leave.linePc" : "leave.line")}</p>
                  <div className="fa-acts">
                    <button
                      type="button"
                      className="lpill solid"
                      disabled={busy}
                      onClick={() => void leave()}
                    >
                      {t("leave.yes")}
                    </button>
                    <button type="button" className="lpill" onClick={() => setLeaving(false)}>
                      {t("leave.no")}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="gc-ghost" onClick={() => setLeaving(true)}>
                  {t("leave.open")}
                </button>
              )}
            </div>
          </details>
        </div>
      </section>
    </main>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </svg>
  );
}

/** Start downloading `url` from this page, without leaving it. */
function startDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** The green WhatsApp button the design leads with. */
function WhatsAppButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="lb-wa" onClick={onClick}>
      <WhatsAppGlyph />
      <span>{label}</span>
    </button>
  );
}
