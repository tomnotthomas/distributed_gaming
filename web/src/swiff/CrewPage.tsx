// The crew pages (/crews): founding a crew in one tap (/crews/new), the crews
// a player is in (/crews), and one crew's lobby (/crews/<id>), in the approved
// "Sofort-Crew" design. Nobody is asked about hardware to found or join: the
// lobby has an open PC slot anyone in the crew fills now or later, reads
// "Almost ready" until a PC is in, and leads with one next step per state.
// Someone who joined is shown, once, what the crew sees on a PC and what it
// does not, with a one-minute PC check and an equally plain "Later", which
// stays as a "Check my PC later" chip. The lobby reads its crew again whenever
// the event stream says something changed, so a PC arriving shows at once.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { STEAM_LOGIN_URL } from "./steam";
import {
  bringPc,
  createCrew,
  crewTitle,
  fetchCrew,
  fetchCrews,
  inviteMessage,
  pcTitle,
  removeCrewMember,
  fetchReminders,
  renameCrew,
  renewCrewLink,
  saveReminders,
  takeLanding,
  takePcFirst,
  type CrewDetail,
  type CrewMember,
  type MyCrew,
  type Reminders,
} from "./crews";
import type { CopyKey } from "./crewCopy";
import {
  Avatar,
  LobbyArt,
  LobbyArtImage,
  LobbyTitle,
  PcIcon,
  ProgressStops,
  Tick,
  useCrewText,
  useShare,
} from "./crewUi";
import { Glyph } from "./Glyph";
import { inviteLink, type Channel } from "./invite";
import { HOST_DOWNLOAD_URL } from "./SharePC";
import type { Swiff } from "./useSwiff";

/** The crew pages, by their address. */
export function CrewPage({ swiff }: { swiff: Swiff }) {
  const { crewRoute, signedIn, signInKnown } = swiff;
  if (!signInKnown) return <CrewLoading />;
  if (!signedIn) return <FoundSignedOut />;
  if (crewRoute.found) return <Founding swiff={swiff} />;
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
              <a className="lpill solid" href={`${STEAM_LOGIN_URL}?to=${encodeURIComponent("/crews/new")}`}>
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

/** /crews/new: the crew is founded at once, and the page becomes its lobby. */
function Founding({ swiff }: { swiff: Swiff }) {
  const { t } = useCrewText();
  const [failed, setFailed] = useState<"full" | true | false>(false);
  const started = useRef(false);
  const { replaceCrew, openCrew } = swiff;

  const found = useCallback(() => {
    setFailed(false);
    void createCrew().then((crew) => {
      if (crew === "full") setFailed("full");
      else if (crew) replaceCrew(crew.id);
      else setFailed(true);
    });
  }, [replaceCrew]);

  // Once per visit: a page that re-renders never founds a second crew.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    found();
  }, [found]);

  return (
    <main className="crew-lobby" data-testid="crew" aria-busy={!failed}>
      <div className="lb-wrap crew-wait">
        {failed ? (
          <div role="alert" className="crew-gone">
            <p>{t(failed === "full" ? "crews.full" : "found.failed")}</p>
            {failed === "full" ? (
              <button type="button" className="lpill solid" onClick={() => openCrew()}>
                {t("gone.back")}
              </button>
            ) : (
              <button type="button" className="lpill solid" onClick={found}>
                {t("crews.retry")}
              </button>
            )}
          </div>
        ) : (
          <p>{t("found.starting")}</p>
        )}
      </div>
    </main>
  );
}

/** /crews: the crews the player is in, and founding another. One crew opens straight away. */
function CrewList({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const [crews, setCrews] = useState<MyCrew[] | "failed" | null>(null);
  // From a "Crew gründen" button on the marketing site: a player with no crew yet gets one at once.
  const [landing] = useState(takeLanding);
  const { openCrew, replaceCrew } = swiff;

  const load = useCallback(() => {
    setCrews(null);
    void fetchCrews().then((answer) => setCrews(answer ?? "failed"));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (Array.isArray(crews) && crews.length === 1) replaceCrew(crews[0]!.id);
    else if (Array.isArray(crews) && !crews.length && landing.found) replaceCrew("new");
  }, [crews, replaceCrew, landing]);

  return (
    <main className="crew-lobby" data-testid="crew">
      <section className="lb-lobby">
        <LobbyArt />
        <div className="lb-wrap lb-in">
          <div>
            <LobbyTitle prose>
              {Array.isArray(crews) && crews.length ? t("crews.title") : t("found.title")}
            </LobbyTitle>
            {crews === null ? (
              <p className="fa-why" aria-busy="true">
                {t("crews.loading")}
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
            {Array.isArray(crews) ? (
              <div className="lb-join">
                <button type="button" className="lpill solid" onClick={() => openCrew("new")}>
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

/** The next step a crew's page leads with, by its state and who is looking. */
type Next = "found" | "joined" | "setup" | "ready" | "offline";

function nextStep(crew: CrewDetail, me: CrewMember): Next {
  if (crew.state === "ready") return "ready";
  if (crew.state === "offline") return "offline";
  if (me.pc === "yes") return "setup";
  return me.admin ? "found" : "joined";
}

/** The day choices for a session: today, tomorrow, and the next three days by name. */
function sessionDays(lang: "de" | "en", now: Date, t: (key: CopyKey) => string): string[] {
  const weekday = new Intl.DateTimeFormat(lang, { weekday: "long" });
  return [0, 1, 2, 3, 4].map((offset) => {
    if (offset === 0) return t("night.today");
    if (offset === 1) return t("night.tomorrow");
    return weekday.format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  });
}

/** The time choices for a session, as the language writes them. */
function sessionTimes(lang: "de" | "en"): string[] {
  const format = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: lang === "en",
  });
  return [15, 18, 20, 21].map((hour) => format.format(new Date(2026, 0, 1, hour)));
}

/** Whether the browser can show a notification, and may already. */
const notifications = () => (typeof Notification === "undefined" ? null : Notification.permission);

/** One crew's lobby. */
function Lobby({ id, swiff }: { id: string; swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const [crew, setCrew] = useState<CrewDetail | "gone" | "failed" | null>(null);
  // From the host side of the marketing site, the PC card comes first.
  const [card, setCard] = useState<boolean | null>(() => (takePcFirst() ? true : null));
  const [night, setNight] = useState(false);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState(3);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(notifications);
  const { note, say, share, copyLink, canShare } = useShare(swiff.inviteShared);
  const { crewChanges, crewReady, dismissCrewReady, openCrew, goHome } = swiff;
  // Asked for, the PC card is scrolled to: it sits below the crew's slots.
  const cardRef = useRef<HTMLElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const openCard = () => setCard(true);
  useEffect(() => {
    if (card) cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [card]);

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
  // Something changed somewhere (a PC came, went or got busy, someone joined): read the crew again.
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
  const title = crewTitle(lang, crew);
  const link = crew.token ? inviteLink(crew.token) : "";
  const message = inviteMessage(lang, crew);
  const myPcs = crew.machines.filter((m) => m.mine);
  const firstPc = crew.machines.find((m) => m.state !== "offline") ?? crew.machines[0];
  const pcName = firstPc ? pcTitle(lang, firstPc) : "";
  const next = nextStep(crew, me);
  // Someone who joined is shown the PC card until they answer it; anyone else when they ask.
  const cardOpen = card ?? (me.pc === null && !me.admin && crew.state === "no-pc");
  // A crew with a PC already takes another from anyone who has none in it yet.
  const addAnother = crew.state !== "no-pc" && !myPcs.length;

  const apply = async (work: Promise<CrewDetail | null>, done?: CopyKey) => {
    setBusy(true);
    const next = await work;
    setBusy(false);
    if (next) {
      setCrew(next);
      if (done) say(t(done));
    } else say(t("toast.failed"));
    return next;
  };

  const shareInvite = (channel: Channel) =>
    void share(channel, message, link, crew.state === "no-pc" ? "toast.asked" : "toast.sent");

  // Their PC plays for the crew from now on, once it runs the app: the next step says how to set it up.
  const checkPc = async () => {
    if (!(await apply(bringPc(id, "yes")))) return;
    setCard(false);
    if (HOST_DOWNLOAD_URL) window.open(HOST_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    else nextRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  const later = async () => {
    if (await apply(bringPc(id, "later"), "toast.later")) setCard(false);
  };

  const askNotify = async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  };

  const saveName = async () => {
    if (renaming === null) return;
    if (await apply(renameCrew(id, renaming), "toast.renamed")) setRenaming(null);
  };

  const leave = async () => {
    setBusy(true);
    const done = await removeCrewMember(me.id);
    setBusy(false);
    if (done) openCrew();
    else say(t("toast.failed"));
  };

  const remove = async (member: CrewMember) => {
    setBusy(true);
    const done = await removeCrewMember(member.id);
    setBusy(false);
    if (done) load(true);
    else say(t("toast.failed"));
  };

  const days = sessionDays(lang, new Date(), t);
  const times = sessionTimes(lang);
  const nightMessage = t("msg.night", { day: days[day]!, time: times[time]!, crew: title, link });

  const memberMeta = (m: CrewMember) =>
    m.admin
      ? t("cp.founder")
      : m.pcs > 0
        ? t("cp.brings")
        : m.pc === "yes"
          ? t("cp.settingUp")
          : m.you
            ? t("cp.joined")
            : "";

  return (
    <main className="crew-lobby" data-testid="crew" data-state={crew.state}>
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
        <div className="lb-wrap lb-in">
          <div>
            <p className="lb-tag">
              <span className="fa-emoji" aria-hidden="true">
                🎮
              </span>
              <span>{t("cp.tag")}</span>
            </p>
            <LobbyTitle>
              <span className="crew-name">{title}</span>
            </LobbyTitle>
            {crew.own ? (
              <div className="crew-name-row">
                {renaming === null ? (
                  <button
                    type="button"
                    className="name-edit"
                    onClick={() => setRenaming(crew.crewName ?? "")}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 20h4L19 9l-4-4L4 16z" />
                    </svg>
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
                )}
              </div>
            ) : null}

            <div className="fa-check" role="status">
              <b className="fa-st">
                {t(
                  crew.state === "ready" ? "cp.ready" : crew.state === "offline" ? "cp.offline" : "cp.almost",
                )}
              </b>
              <span className="fa-item ok">
                <span className="fa-tick">
                  <Tick />
                </span>
                <span>{t("cp.people")}</span>
                <span className="fa-v">{t("cp.peopleIn", { n: crew.size })}</span>
              </span>
              <span className={crew.pcs ? "fa-item ok" : "fa-item"}>
                <span className="fa-tick">
                  <Tick />
                </span>
                <span>{t("cp.pc")}</span>
                <span className="fa-v">
                  {crew.pcs === 0
                    ? t("cp.pcMissing")
                    : crew.state === "offline"
                      ? t("cp.pcOff")
                      : crew.pcs === 1
                        ? t("cp.pcIn", { pc: pcName })
                        : t("cp.pcsIn", { n: crew.pcs })}
                </span>
              </span>
            </div>

            <div className="nx" aria-labelledby="nx-h" ref={nextRef}>
              <span className="nx-k">{t("cp.next")}</span>
              {next === "found" ? (
                <>
                  <h2 id="nx-h">{t("cp.nextFound")}</h2>
                  <p>{t("cp.nextFoundLine")}</p>
                  <WhatsAppButton label={t("cp.whatsapp")} onClick={() => shareInvite("whatsapp")} />
                </>
              ) : next === "joined" ? (
                <>
                  <h2 id="nx-h">{t("cp.nextJoined")}</h2>
                  <p>{t("cp.nextJoinedLine")}</p>
                  <button type="button" className="lpill solid" onClick={openCard}>
                    {t("cp.addPc")}
                    <span className="lpill-c">
                      <Glyph name="arrow" size={18} />
                    </span>
                  </button>
                </>
              ) : next === "setup" ? (
                <>
                  <h2 id="nx-h">{t("cp.nextSetup")}</h2>
                  <p>{t("cp.nextSetupLine", { crew: title })}</p>
                  {HOST_DOWNLOAD_URL ? (
                    <a className="lpill solid" href={HOST_DOWNLOAD_URL}>
                      {t("pcc.download")}
                      <span className="lpill-c">
                        <Glyph name="download" size={18} />
                      </span>
                    </a>
                  ) : (
                    <p className="crew-soon">{t("pcc.soon", { crew: title })}</p>
                  )}
                </>
              ) : next === "ready" ? (
                <>
                  <h2 id="nx-h">{t("cp.nextReady")}</h2>
                  <p>
                    {crew.pcs > 1
                      ? t("cp.nextReadyMany", { n: crew.pcs })
                      : t("cp.nextReadyLine", { pc: pcName })}
                  </p>
                  <button type="button" className="lpill solid" onClick={goHome}>
                    {t("cp.play")}
                    <span className="lpill-c">
                      <Glyph name="arrow" size={18} />
                    </span>
                  </button>
                </>
              ) : (
                <>
                  <h2 id="nx-h">{t("cp.nextOffline")}</h2>
                  <p>{crew.pcs > 1 ? t("cp.nextOfflineMany") : t("cp.nextOfflineLine", { pc: pcName })}</p>
                </>
              )}
            </div>

            <div className="sec-acts" aria-label={t("cp.actions")}>
              <button type="button" className="sa" aria-expanded={night} onClick={() => setNight(!night)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="4" y="5" width="16" height="15" rx="2" />
                  <path d="M4 10h16M9 3v4M15 3v4" />
                </svg>
                {t("cp.planSession")}
              </button>
              {(me.admin && crew.state === "no-pc" && me.pc !== "yes" && me.pc !== "later") ||
              (addAnother && me.pc !== "later") ? (
                <button type="button" className="sa" onClick={openCard}>
                  <PcIcon />
                  {t("cp.havePc")}
                </button>
              ) : null}
              {next !== "found" ? (
                <button type="button" className="sa" onClick={() => shareInvite("whatsapp")}>
                  <LinkIcon />
                  {t("cp.whatsapp")}
                </button>
              ) : null}
              <button type="button" className="sa" onClick={() => void copyLink(link)} disabled={!link}>
                <LinkIcon />
                {t("cp.copy")}
              </button>
              {me.pc === "later" && !myPcs.length && !cardOpen ? (
                <button type="button" className="sa chip-later" onClick={openCard}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                    <path d="M12 8v4l3 2" />
                  </svg>
                  {t("cp.pcLater")}
                </button>
              ) : null}
              {crew.state === "no-pc" && permission !== null && permission !== "denied" ? (
                <button
                  type="button"
                  className="sa"
                  disabled={permission === "granted"}
                  onClick={() => void askNotify()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4" />
                  </svg>
                  {t(permission === "granted" ? "cp.notifyOn" : "cp.notify")}
                </button>
              ) : null}
            </div>
            <p className="cp-toast" role="status" aria-live="polite" hidden={!note}>
              {note}
            </p>
          </div>

          <ol className="lb-slots" aria-label={t("cp.slots")}>
            {crew.members.map((m, i) => (
              <li key={m.id} className="lb-slot">
                <Avatar name={m.name ?? (m.you ? t("cp.you") : null)} index={i} />
                <span className="lb-who">
                  <span className="lb-name">{m.name ?? (m.you ? t("cp.you") : t("cp.anon"))}</span>
                  <span className="lb-meta">{memberMeta(m)}</span>
                </span>
                <span className="crew-slot-foot">
                  <span className="lchip go">{t("cp.readyChip")}</span>
                  {crew.own && !m.you ? (
                    <button
                      type="button"
                      className="crew-remove"
                      disabled={busy}
                      aria-label={t("cp.removeLabel", { name: m.name ?? t("cp.anon") })}
                      onClick={() => void remove(m)}
                    >
                      {t("cp.remove")}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
            {crew.machines.map((pc, i) => (
              <li key={`pc-${i}`} className="lb-slot pc-in">
                <span className="av pc" aria-hidden="true">
                  <PcIcon />
                </span>
                <span className="lb-who">
                  <span className="lb-name">{pcTitle(lang, pc)}</span>
                  <span className="lb-meta">{pc.mine ? t("cp.yourPc") : ""}</span>
                </span>
                <span
                  className={
                    pc.state === "ready" ? "lchip go" : pc.state === "busy" ? "lchip wait" : "lchip free"
                  }
                >
                  {t(pc.state === "ready" ? "cp.pcFree" : pc.state === "busy" ? "cp.pcBusy" : "cp.pcAway")}
                </span>
              </li>
            ))}
            {crew.state === "no-pc" || addAnother ? (
              <li>
                <button type="button" className="lb-slot act pcadd" onClick={openCard}>
                  <span className="av" aria-hidden="true">
                    <PcIcon />
                  </span>
                  <span className="lb-who">
                    <span className="lb-name">{t(addAnother ? "cp.addAnotherPc" : "cp.addPc")}</span>
                    <span className="lb-meta">{t(addAnother ? "cp.addAnotherPcLine" : "cp.addPcLine")}</span>
                  </span>
                  <span className={addAnother ? "lchip free" : "lchip wait"}>
                    {t(addAnother ? "cp.addAnotherChip" : "cp.missing")}
                  </span>
                </button>
              </li>
            ) : null}
            <li>
              <button type="button" className="lb-slot act" onClick={() => shareInvite("whatsapp")}>
                <span className="av" aria-hidden="true">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                <span className="lb-who">
                  <span className="lb-name">{t("cp.invite")}</span>
                  <span className="lb-meta">{t("cp.inviteLine")}</span>
                </span>
                <span className="lchip free">{t("cp.inviteChip")}</span>
              </button>
            </li>
          </ol>
          <p className="slots-note">{t("cp.slotsNote")}</p>
          <ProgressStops crew={crew} label={t("cp.progress")} />
        </div>
      </section>

      <div className="lb-wrap">
        {cardOpen || myPcs.length ? (
          <section className="lb-pcown fa-pcc" aria-labelledby="pcc-h" data-testid="pc-card" ref={cardRef}>
            <figure aria-hidden="true">
              <LobbyArtImage />
            </figure>
            {myPcs.length ? (
              <div>
                <h2 id="pcc-h">{t("pcc.inTitle", { crew: title })}</h2>
                <p className="sub">{t("pcc.inLine")}</p>
                <div className="fa-acts">
                  <button
                    type="button"
                    className="lpill"
                    disabled={busy}
                    onClick={() => void apply(bringPc(id, "off"))}
                  >
                    {t("pcc.out")}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <h2 id="pcc-h">{t("pcc.title")}</h2>
                <div className="fa-sees">
                  <div>
                    <span className="lb-k">{t("pcc.sees")}</span>
                    <p>{t("pcc.seesLine")}</p>
                  </div>
                  <div>
                    <span className="lb-k">{t("pcc.not")}</span>
                    <p>{t("pcc.notLine")}</p>
                  </div>
                </div>
                <p className="sub">{t("pcc.note")}</p>
                <div className="fa-acts">
                  <button
                    type="button"
                    className="lpill solid"
                    disabled={busy}
                    onClick={() => void checkPc()}
                  >
                    {t("pcc.check")}
                    <span className="lpill-c">
                      <Glyph name="arrow" size={18} />
                    </span>
                  </button>
                  <button type="button" className="lpill" disabled={busy} onClick={() => void later()}>
                    {t("pcc.later")}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {night ? (
          <section className="fa-night" aria-labelledby="night-h">
            <h3 id="night-h">{t("night.title")}</h3>
            <div className="fa-row" role="group" aria-label={t("night.day")}>
              <span className="lb-k">{t("night.day")}</span>
              <span className="fa-days">
                {days.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    className="fa-chip"
                    aria-pressed={i === day}
                    onClick={() => setDay(i)}
                  >
                    {d}
                  </button>
                ))}
              </span>
            </div>
            <div className="fa-row" role="group" aria-label={t("night.time")}>
              <span className="lb-k">{t("night.time")}</span>
              <span className="fa-times">
                {times.map((tm, i) => (
                  <button
                    key={tm}
                    type="button"
                    className="fa-chip"
                    aria-pressed={i === time}
                    onClick={() => setTime(i)}
                  >
                    {tm}
                  </button>
                ))}
              </span>
            </div>
            <div className="fa-check">
              <span className="fa-item ok">
                <span className="fa-tick">
                  <Tick />
                </span>
                <span>{t("cp.people")}</span>
                <span className="fa-v">{t("cp.peopleIn", { n: crew.size })}</span>
              </span>
              <span className={crew.pcs ? "fa-item ok" : "fa-item"}>
                <span className="fa-tick">
                  <Tick />
                </span>
                <span>{t("cp.pc")}</span>
                <span className="fa-v">{crew.pcs ? t("cp.pcIn", { pc: pcName }) : t("night.byThen")}</span>
              </span>
            </div>
            <WhatsAppButton
              small
              label={t("night.post")}
              onClick={() => void share("whatsapp", nightMessage, link, "toast.night")}
            />
          </section>
        ) : null}

        <section className="lb-path more-sec" aria-labelledby="more-h">
          <div>
            <h2 id="more-h">{t("share.title")}</h2>
            <div className="lb-share">
              <span className="lb-k" id="cp-lbl">
                {t("share.label")}
              </span>
              <div className="lb-link">
                <code aria-labelledby="cp-lbl">{link.replace(/^https?:\/\//, "")}</code>
                <button type="button" onClick={() => void copyLink(link)} disabled={!link}>
                  {t("cp.copy")}
                </button>
              </div>
              <WhatsAppButton label={t("cp.whatsapp")} onClick={() => shareInvite("whatsapp")} />
              <div className="lb-others">
                <span>{t("share.or")}</span>
                <button type="button" onClick={() => shareInvite("telegram")}>
                  Telegram
                </button>
                <button type="button" onClick={() => shareInvite("discord")}>
                  Discord
                </button>
                <button type="button" onClick={() => shareInvite("signal")}>
                  Signal
                </button>
                {canShare ? (
                  <button type="button" onClick={() => shareInvite("share")}>
                    {t("share.more")}
                  </button>
                ) : null}
              </div>
              {crew.own ? (
                <p className="crew-renew">
                  <button
                    type="button"
                    className="lb-switch"
                    disabled={busy}
                    aria-describedby="crew-renew-hint"
                    onClick={() => void apply(renewCrewLink(id), "toast.renewed")}
                  >
                    {t("share.renew")}
                  </button>{" "}
                  <span id="crew-renew-hint">{t("share.renewHint")}</span>
                </p>
              ) : null}
            </div>
          </div>
          <aside className="lb-phone" aria-labelledby="cp-msgh">
            <p className="lb-k" id="cp-msgh">
              {t("share.preview")}
            </p>
            <div className="lb-bubble">
              <span className="lb-card" aria-hidden="true">
                <LobbyArtImage />
                <span className="t">{t("share.cardTitle")}</span>
                <span className="d">{location.host}</span>
              </span>
              <p>{message}</p>
            </div>
          </aside>
        </section>

        <CrewReminders />

        <section className="crew-leave">
          {leaving ? (
            <div className="crew-leave-ask" role="group" aria-labelledby="leave-h">
              <h3 id="leave-h">{t("leave.title", { crew: title })}</h3>
              <p>{t(myPcs.length ? "leave.linePc" : "leave.line")}</p>
              <div className="fa-acts">
                <button type="button" className="lpill solid" disabled={busy} onClick={() => void leave()}>
                  {t("leave.yes")}
                </button>
                <button type="button" className="lpill" onClick={() => setLeaving(false)}>
                  {t("leave.no")}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="lb-switch" onClick={() => setLeaving(true)}>
              {t("leave.open")}
            </button>
          )}
        </section>
      </div>
    </main>
  );
}

/** The address the reminders confirm form checks, as the server does (signups.ts). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Optional reminders by email, double opt-in (server/src/signups.ts): an
 * address, then "check your inbox", then the address they go to with a way to
 * stop them. Not there at all while the server takes none.
 */
function CrewReminders() {
  const { lang, t } = useCrewText();
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ key: CopyKey; alert?: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    void fetchReminders().then((answer) => {
      if (live) setReminders(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!reminders) return null;

  const save = async (next: string | null) => {
    setBusy(true);
    setNote(null);
    const answer = await saveReminders(next, lang);
    setBusy(false);
    if (!answer) {
      setNote({ key: "rem.failed", alert: true });
      return;
    }
    setReminders(answer);
    if (next !== null && !answer.confirmed) setNote({ key: "rem.sent" });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) setNote({ key: "rem.invalid", alert: true });
    else void save(value);
  };

  return (
    <section className="lb-remind" aria-labelledby="rem-h" data-testid="reminders">
      <div>
        <h2 id="rem-h">{t("rem.title")}</h2>
        <p className="sub">{t("rem.line")}</p>
      </div>
      {reminders.email && reminders.confirmed ? (
        <div className="fa-acts">
          <p>{t("rem.on", { email: reminders.email })}</p>
          <button type="button" className="lpill" disabled={busy} onClick={() => void save(null)}>
            {t("rem.stop")}
          </button>
        </div>
      ) : (
        <form className="rem-form" onSubmit={submit} noValidate>
          <label className="lb-k" htmlFor="rem-email">
            {t("rem.label")}
          </label>
          <div className="rem-row">
            <input
              id="rem-email"
              className="name-in"
              type="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit" className="lpill solid" disabled={busy}>
              {busy ? t("rem.saving") : t("rem.save")}
            </button>
          </div>
        </form>
      )}
      <p className="cp-toast" role={note?.alert ? "alert" : "status"} hidden={!note}>
        {note ? t(note.key, { email: reminders.email ?? email.trim() }) : null}
      </p>
    </section>
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

/** The green WhatsApp button the design leads with. */
function WhatsAppButton({ label, onClick, small }: { label: string; onClick: () => void; small?: boolean }) {
  return (
    <button type="button" className={small ? "lb-wa fa-wa-sm" : "lb-wa"} onClick={onClick}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12.04 2.5a9.45 9.45 0 0 0-8.1 14.33L2.5 21.5l4.8-1.4a9.46 9.46 0 1 0 4.74-17.6zm0 17.3a7.84 7.84 0 0 1-4.02-1.1l-.29-.17-2.85.83.84-2.77-.19-.3a7.85 7.85 0 1 1 6.51 3.51zm4.3-5.88c-.24-.12-1.4-.69-1.61-.77-.22-.08-.37-.12-.53.12-.16.23-.61.77-.75.93-.14.16-.28.18-.51.06a6.4 6.4 0 0 1-3.2-2.8c-.24-.41.24-.38.69-1.27.08-.16.04-.29-.02-.41-.06-.12-.53-1.28-.73-1.75-.19-.46-.39-.4-.53-.4h-.45a.87.87 0 0 0-.63.29 2.64 2.64 0 0 0-.82 1.96 4.6 4.6 0 0 0 .96 2.43 10.5 10.5 0 0 0 4.03 3.56c1.5.65 2.08.7 2.83.59.46-.07 1.4-.57 1.6-1.13.2-.55.2-1.03.14-1.13-.06-.1-.21-.16-.45-.28z"
        />
      </svg>
      <span>{label}</span>
    </button>
  );
}
