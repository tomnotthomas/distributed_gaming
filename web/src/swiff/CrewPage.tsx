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
  setCrewSession,
  sharedCrew,
  takeLanding,
  takePcFirst,
  FOUND_PATH,
  type CrewDetail,
  type CrewMember,
  type CrewSession,
  type MyCrew,
  zoned,
  zonedAt,
} from "./crews";
import { crewText, type CopyKey, type Lang } from "./crewCopy";
import { CrewPlay, playPc } from "./CrewPlay";
import { Avatar, LobbyArt, LobbyTitle, PcIcon, Tick, useCrewText, useShare } from "./crewUi";
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
type StepId = "date" | "people" | "answer" | "pc" | "play";
type Step = { id: StepId; label: CopyKey; done: boolean; value?: string; change?: boolean };

/**
 * The steps to the crew's Zockrunde for whoever looks, from the crew as it is:
 * its admin sets the date, sends it out, gets a gaming PC in and plays;
 * someone who joined says yes or no, gets a gaming PC in and plays. A step
 * that cannot be done yet (answering before there is a date) is never the
 * current one.
 */
export function crewSteps(crew: CrewDetail, me: CrewMember, now: number, lang: Lang): Step[] {
  const t = crewText(lang);
  const session = activeSession(crew, now);
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
    play,
  ];
}

/** The step to do now: the first one not done that can be done. */
function currentStep(steps: Step[], crew: CrewDetail, now: number): StepId {
  const session = activeSession(crew, now);
  const step = steps.find((s) => !s.done && (s.id !== "answer" || session) && (s.id !== "people" || session));
  return step?.id ?? "play";
}

/** The hours a Zockrunde may start at. */
const SESSION_HOURS = [17, 18, 19, 20, 21, 22];

/** The furthest day ahead a Zockrunde may be set on: inside the server's 90 days (SESSION_AHEAD_MS). */
const FURTHEST_DAY = 89;

/**
 * A calendar day in SESSION_ZONE, as the day choices hold it: its midnight in
 * UTC (Unix ms), so the same day reads the same wherever the browser is.
 */
type CalendarDay = number;

/** The calendar day `offset` days after the one `at` falls on in SESSION_ZONE. */
function dayOf(at: number, offset = 0): CalendarDay {
  const { year, month, day } = zoned(at);
  return Date.UTC(year, month, day + offset);
}

/** The moment `hour` o'clock begins on calendar day `day`, in SESSION_ZONE. */
function startOf(day: CalendarDay, hour: number): number {
  const d = new Date(day);
  return zonedAt(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
}

/** A calendar day as `<input type="date">` writes it. */
const isoDay = (day: CalendarDay) => new Date(day).toISOString().slice(0, 10);

/** A calendar day's weekday, in full or short. */
const dayWeekday = (lang: Lang, day: CalendarDay, width: "short" | "long") =>
  new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", { weekday: width, timeZone: "UTC" })
    .format(day)
    .replace(".", "");

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
  const steps = crewSteps(crew, me, now, lang);
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

  const memberMeta = (m: CrewMember) =>
    m.admin ? t("cp.founder") : m.pcs > 0 ? t("cp.brings") : m.pc === "yes" ? t("cp.settingUp") : "";

  const sorted = [...crew.members].sort((a, b) => Number(b.you) - Number(a.you));

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
                  crewId={id}
                  session={crew.session}
                  over={crew.session !== null && session === null}
                  busy={busy}
                  apply={apply}
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
            <section className="gc-who" aria-labelledby="gc-who-h">
              <h2 id="gc-who-h">{t("g.who")}</h2>
              <ul>
                {sorted.map((m, i) => (
                  <li key={m.id} className={m.you ? "me" : undefined}>
                    <Avatar name={m.name ?? (m.you ? t("cp.you") : null)} index={i} />
                    <span className="gc-nm">
                      <span>
                        {m.you
                          ? m.name
                            ? t("g.you", { name: m.name })
                            : t("cp.you")
                          : (m.name ?? t("cp.anon"))}
                      </span>
                      {memberMeta(m) ? <small>{memberMeta(m)}</small> : null}
                    </span>
                    <span className={`gc-ans ${m.rsvp ?? ""}`}>
                      <span className="d" aria-hidden="true">
                        {m.rsvp === "yes" ? <Tick /> : null}
                      </span>
                      {t(
                        m.rsvp === "yes"
                          ? "g.ansYes"
                          : m.rsvp === "no"
                            ? "g.ansNo"
                            : m.you
                              ? "g.ansYou"
                              : "g.ansOpen",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
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

/** Setting the crew's Zockrunde, or moving it: a day, a time, and one button that says both. */
function DateStep({
  crewId,
  session,
  over,
  busy,
  apply,
}: {
  crewId: string;
  session: CrewSession | null;
  over: boolean;
  busy: boolean;
  apply: (work: Promise<CrewDetail | null>) => Promise<CrewDetail | null>;
}) {
  const { lang, t } = useCrewText();
  // Read again on every pick and before setting, so a page left open never sets a time already gone.
  const [now, setNow] = useState(() => Date.now());
  const days = [0, 1, 2, 3, 4].map((offset) => dayOf(now, offset));
  const moving = session !== null && !over;
  // Friday when it is among the days, else tomorrow; a session being moved starts from its own day.
  const [day, setDay] = useState<CalendarDay>(() =>
    moving ? dayOf(session.at) : (days.find((d) => new Date(d).getUTCDay() === 5) ?? days[1]!),
  );
  const [hour, setHour] = useState(() => (moving ? zoned(session.at).hour : 21));
  const [other, setOther] = useState(() => !days.includes(day));
  const at = startOf(day, hour);
  const past = at < now;
  const pick = (next: () => void) => {
    setNow(Date.now());
    next();
  };
  const short = (d: CalendarDay) =>
    `${dayWeekday(lang, d, "short")} ${new Date(d).getUTCDate()}${lang === "de" ? "." : ""}`;
  const dayName = (d: CalendarDay, i: number) =>
    i === 0 ? t("g.today") : i === 1 ? t("g.tomorrow") : dayWeekday(lang, d, "long");
  const whenDay = days.indexOf(day);
  const when = `${
    whenDay >= 0 && !other
      ? dayName(day, whenDay)
      : `${dayWeekday(lang, day, "long")} ${new Date(day).getUTCDate()}${lang === "de" ? "." : ""}`
  }, ${sessionTime(lang, at)}`;

  const set = () => {
    const current = Date.now();
    setNow(current);
    if (at >= current) void apply(setCrewSession(crewId, at));
  };

  return (
    <>
      <h2>{t(moving ? "g.moveH" : over ? "g.nextH" : "g.dateH")}</h2>
      <p className="gc-p">{t(moving ? "g.moveP" : "g.dateP")}</p>
      <div className="gc-pick">
        <fieldset>
          <legend>{t("g.day")}</legend>
          <div className="gc-chips">
            {days.map((d, i) => (
              <button
                key={d}
                type="button"
                className="gc-chip"
                aria-pressed={!other && d === day}
                onClick={() =>
                  pick(() => {
                    setOther(false);
                    setDay(d);
                  })
                }
              >
                <span>{dayName(d, i)}</span>
                <small>{short(d)}</small>
              </button>
            ))}
            {other ? (
              <input
                className="gc-chip gc-other"
                type="date"
                aria-label={t("g.otherDay")}
                min={isoDay(days[0]!)}
                max={isoDay(dayOf(now, FURTHEST_DAY))}
                value={isoDay(day)}
                onChange={(event) => {
                  const [y, m, d] = event.target.value.split("-").map(Number);
                  if (!y || !m || !d) return;
                  const picked = Date.UTC(y, m - 1, d);
                  if (picked >= days[0]! && picked <= dayOf(now, FURTHEST_DAY)) pick(() => setDay(picked));
                }}
              />
            ) : (
              <button
                type="button"
                className="gc-chip gc-other"
                aria-pressed={false}
                onClick={() => pick(() => setOther(true))}
              >
                <span>{t("g.otherDay")}</span>
              </button>
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend>{t("g.time")}</legend>
          <div className="gc-chips">
            {SESSION_HOURS.map((h) => (
              <button
                key={h}
                type="button"
                className="gc-chip t"
                aria-pressed={h === hour}
                onClick={() => pick(() => setHour(h))}
              >
                {`${String(h).padStart(2, "0")}:00`}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="gc-go">
        <button type="button" className="lpill solid" disabled={busy || past} onClick={set}>
          {t(moving ? "g.move" : "g.set", { when })}
          <span className="lpill-c">
            <Glyph name="arrow" size={18} />
          </span>
        </button>
        <p className="gc-fine">{t("g.setFine")}</p>
      </div>
    </>
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

/** WhatsApp's mark. */
function WhatsAppGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.04 2.5a9.45 9.45 0 0 0-8.1 14.33L2.5 21.5l4.8-1.4a9.46 9.46 0 1 0 4.74-17.6zm0 17.3a7.84 7.84 0 0 1-4.02-1.1l-.29-.17-2.85.83.84-2.77-.19-.3a7.85 7.85 0 1 1 6.51 3.51zm4.3-5.88c-.24-.12-1.4-.69-1.61-.77-.22-.08-.37-.12-.53.12-.16.23-.61.77-.75.93-.14.16-.28.18-.51.06a6.4 6.4 0 0 1-3.2-2.8c-.24-.41.24-.38.69-1.27.08-.16.04-.29-.02-.41-.06-.12-.53-1.28-.73-1.75-.19-.46-.39-.4-.53-.4h-.45a.87.87 0 0 0-.63.29 2.64 2.64 0 0 0-.82 1.96 4.6 4.6 0 0 0 .96 2.43 10.5 10.5 0 0 0 4.03 3.56c1.5.65 2.08.7 2.83.59.46-.07 1.4-.57 1.6-1.13.2-.55.2-1.03.14-1.13-.06-.1-.21-.16-.45-.28z"
      />
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
