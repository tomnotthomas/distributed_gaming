// Planning a Zockrunde on the crew page, in the approved ticket design
// (data/lanterel-design-round mockups c-calendar and d-games, impeccable):
// picking its day on a month calendar that marks the days the gaming PC
// already plays for another crew; who is coming, with a WhatsApp nudge for
// whoever has not answered and the date for their own calendar; and picking
// the games to play, the ones everyone can play apart from those only some
// own, with the crew's favourite on top.

import { useEffect, useRef, useState } from "react";
import {
  crewFavourite,
  fetchCrewGames,
  listNames,
  nudgeMessage,
  pcTitle,
  sessionCalendar,
  sessionClock,
  sessionTime,
  sessionWeekday,
  sessionWhen,
  setCrewSession,
  wantCrewGame,
  zoned,
  zonedAt,
  CREWS_PATH,
  type CrewBusy,
  type CrewDetail,
  type CrewGame,
  type CrewGames,
  type CrewMember,
  type CrewSession,
} from "./crews";
import type { Lang } from "./crewCopy";
import { Avatar, Tick, useCrewText, WhatsAppGlyph, type useShare } from "./crewUi";
import { Glyph } from "./Glyph";

/** The hours a Zockrunde may start at. */
const SESSION_HOURS = [17, 18, 19, 20, 21, 22];

/** The furthest day ahead a Zockrunde may be set on: inside the server's 90 days (SESSION_AHEAD_MS). */
const FURTHEST_DAY = 89;

/**
 * A calendar day in SESSION_ZONE, as the calendar holds it: its midnight in
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

/** A calendar day in the language's words, by `options`. */
const dayFormat = (lang: Lang, day: CalendarDay, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", { ...options, timeZone: "UTC" }).formatToParts(
    day,
  );

/** A calendar day as the ticket says it: "Fr 9. Okt", "Fri 9 Oct". */
export function calendarDay(lang: Lang, day: CalendarDay): string {
  const parts = dayFormat(lang, day, { weekday: "short", day: "numeric", month: "short" });
  const part = (type: string) => parts.find((p) => p.type === type)?.value.replace(".", "") ?? "";
  return lang === "de"
    ? `${part("weekday")} ${part("day")}. ${part("month")}`
    : `${part("weekday")} ${part("day")} ${part("month")}`;
}

/** A calendar day short, as the busy note lists it: "Sa 10.", "Sat 10". */
function calendarDate(lang: Lang, day: CalendarDay): string {
  const parts = dayFormat(lang, day, { weekday: "short", day: "numeric" });
  const part = (type: string) => parts.find((p) => p.type === type)?.value.replace(".", "") ?? "";
  return lang === "de" ? `${part("weekday")} ${part("day")}.` : `${part("weekday")} ${part("day")}`;
}

/** A month's name and year: "Oktober 2026", "October 2026". */
const monthName = (lang: Lang, year: number, month: number) =>
  new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month, 1));

/** Monday to Sunday, as the calendar's head shows them: "Mo", "Di"; "Mo", "Tu". */
const weekdayHeads = (lang: Lang) =>
  // 5 January 2026 is a Monday.
  [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const day = Date.UTC(2026, 0, 5 + i);
    const short = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
      weekday: "short",
      timeZone: "UTC",
    })
      .format(day)
      .replace(".", "");
    return short.slice(0, 2);
  });

/** The first day, the furthest day, and which day to start on: a Friday evening when one is near. */
function firstPick(now: number, session: CrewSession | null): { day: CalendarDay; hour: number } {
  if (session) return { day: dayOf(session.at), hour: zoned(session.at).hour };
  for (let offset = 0; offset < 7; offset++) {
    const day = dayOf(now, offset);
    if (new Date(day).getUTCDay() === 5 && startOf(day, 21) > now) return { day, hour: 21 };
  }
  return { day: dayOf(now, 1), hour: 21 };
}

/**
 * Setting the crew's Zockrunde, or moving it: a day on a month calendar that
 * marks the days one of the crew's PCs already plays for another crew, a time,
 * and one button that says both.
 */
export function DateStep({
  crew,
  over,
  busy,
  apply,
}: {
  crew: Pick<CrewDetail, "id" | "session" | "busy" | "machines">;
  over: boolean;
  busy: boolean;
  apply: (work: Promise<CrewDetail | null>) => Promise<CrewDetail | null>;
}) {
  const { lang, t } = useCrewText();
  // Read again on every pick and before setting, so a page left open never sets a time already gone.
  const [now, setNow] = useState(() => Date.now());
  const moving = crew.session !== null && !over;
  const [pick, setPick] = useState(() => firstPick(now, moving ? crew.session : null));
  const shown0 = new Date(pick.day);
  const [shown, setShown] = useState({ year: shown0.getUTCFullYear(), month: shown0.getUTCMonth() });
  const today = dayOf(now);
  const furthest = dayOf(now, FURTHEST_DAY);
  const at = startOf(pick.day, pick.hour);
  const past = at < now;
  const choose = (next: { day: CalendarDay; hour: number }) => {
    setNow(Date.now());
    setPick(next);
  };

  // The days another crew already has one of this crew's PCs, by calendar day.
  const busyDays = new Map<CalendarDay, CrewBusy[]>();
  for (const b of crew.busy) busyDays.set(dayOf(b.at), [...(busyDays.get(dayOf(b.at)) ?? []), b]);

  const first = Date.UTC(shown.year, shown.month, 1);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate();
  const days = Array.from({ length }, (_, i) => Date.UTC(shown.year, shown.month, i + 1));
  const canBack = first > today;
  const canOn = Date.UTC(shown.year, shown.month + 1, 1) <= furthest;
  const turn = (by: number) => {
    const next = new Date(Date.UTC(shown.year, shown.month + by, 1));
    setShown({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  };

  // The busy days in the month shown, one line per PC and starting time.
  const notes = new Map<string, { owner: string | null; mine: boolean; time: string; days: CalendarDay[] }>();
  for (const [day, list] of [...busyDays].sort(([a], [b]) => a - b)) {
    if (day < first || day > days[days.length - 1]! || day < today) continue;
    for (const b of list) {
      const key = `${b.mine ? "" : (b.owner ?? "")}|${b.mine}|${sessionClock(b.at)}`;
      const note = notes.get(key) ?? {
        owner: b.owner,
        mine: b.mine,
        time: sessionTime(lang, b.at),
        days: [],
      };
      if (!note.days.includes(day)) note.days.push(day);
      notes.set(key, note);
    }
  }
  const owners = [...new Set([...notes.values()].map((n) => (n.mine ? null : n.owner)))];
  const noteDays = new Set([...notes.values()].flatMap((n) => n.days)).size;
  const anyBusy = [...busyDays.keys()].some((d) => d >= today);

  const set = () => {
    const current = Date.now();
    setNow(current);
    if (at >= current) void apply(setCrewSession(crew.id, at));
  };
  const when = `${calendarDay(lang, pick.day)}, ${sessionTime(lang, at)}`;

  return (
    <>
      <h2>{t(moving ? "g.moveH" : over ? "g.nextH" : "cal.h")}</h2>
      <p className="gc-p">
        {moving ? t("g.moveP") : t("cal.p")}
        {anyBusy ? ` ${t("cal.pBusy")}` : ""}
      </p>
      <div className="gp-cal">
        <div>
          <div className="gp-month">
            <div className="gp-mh">
              <button type="button" aria-label={t("cal.prev")} disabled={!canBack} onClick={() => turn(-1)}>
                <Caret back />
              </button>
              <b aria-live="polite">{monthName(lang, shown.year, shown.month)}</b>
              <button type="button" aria-label={t("cal.next")} disabled={!canOn} onClick={() => turn(1)}>
                <Caret />
              </button>
            </div>
            <div className="gp-wd" aria-hidden="true">
              {weekdayHeads(lang).map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="gp-days">
              {Array.from({ length: lead }, (_, i) => (
                <span key={`lead-${i}`} />
              ))}
              {days.map((day) => {
                const off = day < today || day > furthest;
                const dayBusy = busyDays.has(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={
                      [day === today ? "today" : "", dayBusy ? "busy" : ""].join(" ").trim() || undefined
                    }
                    disabled={off}
                    aria-pressed={day === pick.day}
                    aria-label={`${calendarDay(lang, day)}${dayBusy ? `, ${t("cal.busyKey")}` : ""}`}
                    onClick={() => choose({ day, hour: pick.hour })}
                  >
                    {new Date(day).getUTCDate()}
                    {dayBusy ? <i className="gp-bz" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="gp-key">
            <span>
              <u />
              {t("cal.today")}
            </span>
            {anyBusy ? (
              <span>
                <i />
                {t("cal.busyKey")}
              </span>
            ) : null}
          </p>
        </div>
        <div className="gp-side">
          <fieldset>
            <legend>{t("cal.timeOn", { day: calendarDay(lang, pick.day) })}</legend>
            <div className="gc-chips">
              {SESSION_HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="gc-chip t"
                  aria-pressed={h === pick.hour}
                  onClick={() => choose({ day: pick.day, hour: h })}
                >
                  {`${String(h).padStart(2, "0")}:00`}
                </button>
              ))}
            </div>
          </fieldset>
          {notes.size ? (
            <p className="gp-warn" role="note">
              <WarnIcon />
              <span>
                {[...notes.values()]
                  .map((n) =>
                    t(n.mine ? "cal.warnMine" : "cal.warn", {
                      days: listNames(
                        lang,
                        n.days.map((d) => calendarDate(lang, d)),
                      ),
                      pc: pcTitle(lang, { name: null, owner: n.owner }),
                      time: n.time,
                    }),
                  )
                  .join(" ")}{" "}
                {owners.length === 1 && owners[0]
                  ? t(noteDays > 1 ? "cal.warnAsk" : "cal.warnAskOne", { name: owners[0]! })
                  : t(noteDays > 1 ? "cal.warnEarlier" : "cal.warnEarlierOne")}
              </span>
            </p>
          ) : null}
          <div className="gc-go">
            <button type="button" className="lpill solid" disabled={busy || past} onClick={set}>
              {t(moving ? "g.move" : "g.set", { when })}
              <span className="lpill-c">
                <Glyph name="arrow" size={18} />
              </span>
            </button>
            <p className="gc-fine">{t("cal.fine")}</p>
          </div>
        </div>
      </div>
    </>
  );
}

/** Start downloading `text` as file `name` from this page, without leaving it. */
function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Who is coming to the crew's Zockrunde: who said yes, who can't and who has
 * not answered yet; a WhatsApp nudge for those, the date for the viewer's own
 * calendar, moving it (its admin), and how the invite looks to the ones who
 * still have to answer.
 */
export function WhoIsComing({
  crew,
  session,
  share,
  onMove,
}: {
  crew: CrewDetail;
  session: CrewSession;
  share: ReturnType<typeof useShare>["share"];
  onMove: (() => void) | null;
}) {
  const { lang, t } = useCrewText();
  const name = (m: CrewMember) =>
    m.you ? (m.name ? t("g.you", { name: m.name }) : t("cp.you")) : (m.name ?? t("cp.anon"));
  const index = new Map(crew.members.map((m, i) => [m.id, i]));
  const yes = crew.members.filter((m) => m.rsvp === "yes");
  const no = crew.members.filter((m) => m.rsvp === "no");
  const open = crew.members.filter((m) => m.rsvp === null);
  const others = open.filter((m) => !m.you);
  const otherNames = others.flatMap((m) => (m.name ? [m.name] : []));
  const page = `${location.origin}${CREWS_PATH}/${encodeURIComponent(crew.id)}`;
  const yesNames = yes.flatMap((m) => (m.name ? [m.name] : []));

  const nudge = () =>
    void share("whatsapp", nudgeMessage(lang, crew, otherNames, session.at), page, "toast.nudged");
  const toCalendar = () =>
    download("zockrunde.ics", "text/calendar", sessionCalendar(lang, crew, session.at));

  const group = (kind: "yes" | "no" | "open", members: CrewMember[]) =>
    members.length ? (
      <div className={`gp-grp ${kind}`}>
        <h3>
          <span>{t(kind === "yes" ? "who.yes" : kind === "no" ? "who.no" : "who.open")}</span>{" "}
          <span className="n">{members.length}</span>
        </h3>
        <ul>
          {members.map((m) => (
            <li key={m.id}>
              <Avatar name={m.name ?? (m.you ? t("cp.you") : null)} index={index.get(m.id) ?? 0} />
              <span>{name(m)}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <section className="gc-who gp-who" aria-labelledby="gc-who-h">
      <h2 id="gc-who-h">{t("who.h", { day: sessionWeekday(lang, session.at, "long") })}</h2>
      <div className="gp-c2">
        <div className="gp-groups">
          {group("yes", yes)}
          {group("no", no)}
          {group("open", open)}
          <div className="gc-acts">
            {others.length ? (
              <button type="button" className="lb-wa" onClick={nudge}>
                <WhatsAppGlyph />
                <span>
                  {others.length > 1
                    ? t("who.nudgeN", { n: others.length })
                    : otherNames.length === 1
                      ? t("who.nudge", { name: otherNames[0]! })
                      : t("who.nudgeOne")}
                </span>
              </button>
            ) : null}
            <button type="button" className="gc-ghost" onClick={toCalendar}>
              <CalendarIcon />
              {t("who.calendar")}
            </button>
          </div>
          {onMove ? (
            <button type="button" className="gp-txt" onClick={onMove}>
              {t("who.move")}
            </button>
          ) : null}
        </div>
        {others.length ? (
          <div className="gp-seen">
            <p>
              {others.length === 1 && otherNames.length === 1
                ? t("who.sees", { name: otherNames[0]! })
                : t("who.seesAnon")}
            </p>
            <div className="gp-mini">
              <b>{t("who.miniH", { when: sessionWhen(lang, session.at) })}</b>
              {yesNames.length ? (
                <span>
                  {t(yesNames.length === 1 ? "who.miniInOne" : "who.miniIn", {
                    names: listNames(lang, yesNames),
                  })}
                </span>
              ) : null}
              <div className="gp-row2" aria-hidden="true">
                <span>{t("g.yes")}</span>
                <span>{t("g.no")}</span>
              </div>
            </div>
            <p>{t("who.remind")}</p>
          </div>
        ) : (
          <p className="gp-remind">{t("who.remind")}</p>
        )}
      </div>
    </section>
  );
}

/**
 * Picking the games to play at the Zockrunde: the games on the crew's PCs,
 * the ones everyone can play apart from those only some own, each with who
 * else wants it; a tap marks or unmarks one, and the crew's favourite sits on
 * top. Read again whenever the crew changes (`changes`), so others' marks show.
 */
export function GamesStep({
  crewId,
  members,
  session,
  changes,
  onPick,
  onDone,
  say,
}: {
  crewId: string;
  members: CrewMember[];
  session: CrewSession | null;
  changes: number;
  onPick: () => void;
  onDone: () => void;
  say: (text: string | null) => void;
}) {
  const { lang, t } = useCrewText();
  const [read, setRead] = useState<CrewGames | "failed" | null>(null);
  // Marks still on their way: a read that lands meanwhile must not undo them.
  const pending = useRef(0);

  const load = (quiet: boolean) => {
    if (!quiet) setRead(null);
    void fetchCrewGames(crewId).then((answer) => {
      if (pending.current) return;
      if (answer) setRead(answer);
      else if (!quiet) setRead("failed");
    });
  };
  const first = useRef(true);
  useEffect(() => {
    load(!first.current);
    first.current = false;
  }, [crewId, changes]);

  if (read === null)
    return (
      <p className="gc-p" aria-busy="true">
        {t("gm.loading")}
      </p>
    );
  if (read === "failed")
    return (
      <div role="alert" className="crew-gone">
        <p>{t("gm.failed")}</p>
        <button type="button" className="lpill" onClick={() => load(false)}>
          {t("crews.retry")}
        </button>
      </div>
    );

  const me = members.find((m) => m.you)!;
  const index = new Map(members.map((m, i) => [m.id, i]));
  const initial = (id: string) => members.find((m) => m.id === id);
  const day = session ? sessionWeekday(lang, session.at, "long") : null;
  const marked = read.games.filter((g) => g.mine).length;
  const favourite = crewFavourite(read.games);
  const everyone = read.games.filter((g) => g.everyone);
  const some = read.games.filter((g) => !g.everyone);

  const toggle = async (game: CrewGame) => {
    const want = !game.mine;
    onPick();
    // Shown at once; the answer replaces it.
    const before = read;
    setRead({
      ...read,
      games: read.games.map((g) =>
        g.id === game.id
          ? {
              ...g,
              mine: want,
              wants: want ? [...g.wants, me.id] : g.wants.filter((id) => id !== me.id),
            }
          : g,
      ),
    });
    pending.current++;
    const answer = await wantCrewGame(crewId, game.id, want);
    pending.current--;
    if (answer) {
      if (!pending.current) setRead(answer);
    } else {
      // Only this game goes back: another mark still on its way, or already through, stays.
      const previous = before.games.find((g) => g.id === game.id);
      setRead((current) =>
        current && current !== "failed" && previous
          ? { ...current, games: current.games.map((g) => (g.id === game.id ? previous : g)) }
          : current,
      );
      say(t("toast.failed"));
    }
  };

  const tile = (game: CrewGame) => {
    const wanting = [...game.wants].sort((a, b) => Number(b === me.id) - Number(a === me.id));
    return (
      <li key={game.id}>
        <button type="button" className="gp-game" aria-pressed={game.mine} onClick={() => void toggle(game)}>
          <span className="gp-sel" aria-hidden="true">
            <Tick />
          </span>
          {game.image ? <img src={game.image} alt="" loading="lazy" /> : <span className="gp-noart" />}
          <span className="gp-gt">
            <b>{game.name}</b>
            <small>
              {game.free
                ? t("gm.free")
                : game.everyone
                  ? t("gm.ownAll")
                  : t("gm.own", { n: game.owners, of: read.size })}
            </small>
            <span className="gp-wants">
              {wanting.length ? (
                <span className="gp-mavs" aria-hidden="true">
                  {wanting.slice(0, 4).map((id) => {
                    const m = initial(id);
                    return (
                      <span key={id} className={id === me.id ? "gp-mav me" : "gp-mav"}>
                        <Avatar name={m?.name ?? (m?.you ? t("cp.you") : null)} index={index.get(id) ?? 0} />
                      </span>
                    );
                  })}
                </span>
              ) : null}
              <span className="gp-wn">
                {wanting.length === 0
                  ? t("gm.want0")
                  : wanting.length === 1
                    ? t("gm.want1")
                    : t("gm.wantN", { n: wanting.length })}
              </span>
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      <div className="gp-head">
        <div className="gp-intro">
          <h2>{day ? t("gm.h", { day }) : t("gm.hAny")}</h2>
          <p className="gc-p">{t("gm.p")}</p>
        </div>
        {favourite ? (
          <div className="gp-fav">
            {favourite.image ? <img src={favourite.image} alt="" /> : <span className="gp-noart" />}
            <p>
              <span className="k">{t("gm.fav")}</span>
              <b>{favourite.name}</b>
              <span>{t("gm.favN", { n: favourite.wants.length, of: read.size })}</span>
            </p>
          </div>
        ) : null}
      </div>
      {read.games.length === 0 ? <p className="gc-fine">{t("gm.empty")}</p> : null}
      {everyone.length ? (
        <>
          <p className="gp-gh">
            <span>{t("gm.all")}</span> <small>{t("gm.allSub")}</small>
          </p>
          <ul className="gp-games">{everyone.map(tile)}</ul>
        </>
      ) : null}
      {some.length ? (
        <>
          <p className="gp-gh">
            <span>{t("gm.some")}</span> <small>{t("gm.someSub")}</small>
          </p>
          <ul className="gp-games">{some.map(tile)}</ul>
        </>
      ) : null}
      <div className="gc-go">
        <button type="button" className="lpill solid" onClick={onDone}>
          {marked === 0 ? t("gm.doneNone") : marked === 1 ? t("gm.doneOne") : t("gm.done", { n: marked })}
          <span className="lpill-c">
            <Tick />
          </span>
        </button>
        <p className="gc-fine">{day ? t("gm.fine", { day }) : t("gm.fineAny")}</p>
      </div>
    </>
  );
}

function Caret({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={back ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </svg>
  );
}
