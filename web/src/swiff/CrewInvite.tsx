// The page a crew's link opens (/invite/<token>), in the approved "ticket"
// design (data/lanterel-design-round, b-invite impeccable): who asks you into
// which crew and when its Zockrunde is, with one button that joins and says
// yes, and beside it the Zockrunde as a ticket: its date, who is in, who
// can't, the friend's own open spot, and whether a gaming PC is in yet.
// "Can't make it" still joins, answering no. Signed out, the button is Steam
// sign-in, which comes back here and joins at once with the answer chosen;
// signed in, it joins. Either way the friend lands on the crew's page.

import { useEffect, useMemo, useRef, useState } from "react";
import { sessionClock, sessionDate, sessionDay, sessionTime, sessionWeekday, type Rsvp } from "./crews";
import { Avatar, LobbyArt, PcIcon, Tick, useCrewText } from "./crewUi";
import { Glyph } from "./Glyph";
import {
  cameBackToJoin,
  forgetInvite,
  INVITE_PATH,
  meanToJoin,
  inviteTokenAt,
  joinInvite,
  openInvite,
  rememberInvite,
  rememberedInvite,
  signInForInvite,
  type OpenedInvite,
} from "./invite";
import type { Swiff } from "./useSwiff";

/** Where the friend stands: reading the invite, a link that opens nothing, or the invite. */
type Opened = OpenedInvite | "invalid" | "unanswered" | null;

export function CrewInvite({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  // Back from "Join with Steam": the tab noted it was going there to join, which counts once.
  const fromSignIn = useMemo(() => (inviteTokenAt(location.pathname) === "" ? cameBackToJoin() : null), []);
  const token = useMemo(() => inviteTokenAt(location.pathname) || rememberedInvite(), []);
  const { signedIn, signInKnown, openCrew, goStart } = swiff;
  const [opened, setOpened] = useState<Opened>(token ? null : "invalid");
  const [joining, setJoining] = useState(false);
  const [joinFailed, setJoinFailed] = useState<"full" | boolean>(false);
  const [attempt, setAttempt] = useState(0);
  const joinedOnce = useRef(false);

  // The token leaves the address bar and history once this tab holds it; with storage blocked it stays in the path.
  useEffect(() => {
    if (inviteTokenAt(location.pathname) && rememberInvite(token)) {
      history.replaceState(history.state, "", INVITE_PATH + location.search);
    }
  }, [token]);

  // Read again once sign-in is known: whether they are in the crew already depends on it.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void openInvite(token).then((answer) => {
      if (live) setOpened(answer ?? "unanswered");
    });
    return () => {
      live = false;
    };
  }, [token, signedIn, attempt]);

  const join = (rsvp: Rsvp | null) => {
    setJoining(true);
    setJoinFailed(false);
    void joinInvite(token, rsvp).then((answer) => {
      setJoining(false);
      if (answer === "invalid") setOpened("invalid");
      else if (answer === "full") setJoinFailed("full");
      else if (answer) {
        forgetInvite();
        openCrew(answer.id);
      } else setJoinFailed(true);
    });
  };

  // Back from "Join with Steam": join without asking twice.
  useEffect(() => {
    if (
      !fromSignIn ||
      !signInKnown ||
      !signedIn ||
      joinedOnce.current ||
      !opened ||
      typeof opened !== "object"
    )
      return;
    joinedOnce.current = true;
    join(fromSignIn === "join" ? null : fromSignIn);
    // join reads only the token, which never changes.
  }, [fromSignIn, signInKnown, signedIn, opened]);

  if (opened === "invalid" || opened === "unanswered") {
    return (
      <main className="crew-lobby" data-testid="invite">
        <div className="lb-wrap crew-wait crew-gone">
          <h1>{t(opened === "invalid" ? "jn.invalid" : "jn.unanswered")}</h1>
          {opened === "invalid" ? <p>{t("jn.invalidLine")}</p> : null}
          <div className="fa-acts">
            {opened === "unanswered" ? (
              <button
                type="button"
                className="lpill solid"
                onClick={() => {
                  setOpened(null);
                  setAttempt((n) => n + 1);
                }}
              >
                {t("jn.retry")}
              </button>
            ) : null}
            <button type="button" className="lpill" onClick={goStart}>
              {t("jn.back")}
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (opened === null) {
    return (
      <main className="crew-lobby" data-testid="invite" aria-busy="true">
        <p className="lb-wrap crew-wait">{t("jn.loading")}</p>
      </main>
    );
  }

  const crew = opened;
  const name = crew.name;
  const crewName = crew.crewName ?? t("jn.crewWord");
  const session = crew.session;
  const answer: Rsvp | null = session ? "yes" : null;
  const main = (
    <>
      <span className="ci-pill-t">
        <span>{t(session ? "ci.in" : "ci.joinCrew")}</span>
        {signedIn ? null : <small>{t("ci.withSteam")}</small>}
      </span>
      <span className="lpill-c">
        <Glyph name="arrow" size={18} />
      </span>
    </>
  );
  const buttons = !signedIn ? (
    <>
      <a className="lpill solid ci-main" href={signInForInvite(token)} onClick={() => meanToJoin(answer)}>
        {main}
      </a>
      {session ? (
        <a className="ci-txt" href={signInForInvite(token)} onClick={() => meanToJoin("no")}>
          {t("ci.cant")}
        </a>
      ) : null}
    </>
  ) : (
    <>
      <button
        type="button"
        className="lpill solid ci-main"
        onClick={() => join(answer)}
        disabled={joining}
        aria-busy={joining}
      >
        {main}
      </button>
      {session ? (
        <button type="button" className="ci-txt" onClick={() => join("no")} disabled={joining}>
          {t("ci.cant")}
        </button>
      ) : null}
    </>
  );
  const founder = crew.guests.find((g) => g.admin)?.name ?? name;
  const pcLine =
    crew.state === "ready"
      ? [crew.pcs > 1 ? t("ci.pcInMany", { n: crew.pcs }) : t("ci.pcIn"), t("ci.pcInLine")]
      : crew.state === "offline"
        ? [t("ci.pcOff"), t("ci.pcOffLine")]
        : [t("ci.pcMissing"), t("ci.pcMissingLine")];

  return (
    <main className="crew-lobby gc ci" data-testid="invite" data-state={crew.state}>
      <section className="lb-lobby" aria-labelledby="lb-h1">
        <LobbyArt />
        <div className="ci-wrap">
          <div className="ci-lead">
            <h1 id="lb-h1" className="ci-h">
              {name ? t("jn.wants", { name }) : t("jn.invited")} <b>{crewName}</b>.
            </h1>
            <span className="mark" aria-hidden="true" />
            <p className="ci-when">
              {session
                ? t("ci.when", { day: sessionDate(lang, session.at), time: sessionTime(lang, session.at) })
                : t("ci.noDate")}
            </p>
            <div className="ci-acts">
              {crew.member ? (
                <>
                  <p role="status">{t("jn.member")}</p>
                  <button type="button" className="lpill solid" onClick={() => openCrew()}>
                    {t("jn.toCrew")}
                    <span className="lpill-c">
                      <Glyph name="arrow" size={18} />
                    </span>
                  </button>
                </>
              ) : (
                buttons
              )}
              {joinFailed ? (
                <p role="alert">{t(joinFailed === "full" ? "crews.full" : "jn.joinFailed")}</p>
              ) : null}
            </div>
            {crew.member ? null : <p className="ci-fine">{t("ci.fine")}</p>}
          </div>

          <section className="gc-tk ci-tk" aria-labelledby="ci-date">
            <div className="gc-head">
              <h2 className={session ? "gc-date" : "gc-date none"} id="ci-date">
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
            </div>
            <ul className="ci-people" aria-label={t("g.who")}>
              {crew.guests.map((g, i) => (
                <li key={i} className={session && g.rsvp === "no" ? "no" : undefined}>
                  <Avatar name={g.name ?? t("cp.anon")} index={0} />
                  <span className="gc-nm">
                    <span>{g.name ?? t("cp.anon")}</span>
                    {g.admin ? <small>{t("jn.founder")}</small> : null}
                  </span>
                  {session ? <Answer rsvp={g.rsvp} /> : null}
                </li>
              ))}
              {crew.member ? null : (
                <li className="you">
                  <Avatar name={null} index={1} empty="?" />
                  <span className="gc-nm">
                    <span>{t("ci.yourSeat")}</span>
                    <small>{founder ? t("jn.saving", { name: founder }) : t("jn.savingAnon")}</small>
                  </span>
                  {session ? <Answer rsvp={null} /> : null}
                </li>
              )}
            </ul>
            <div className="ci-pc">
              <PcIcon />
              <p>
                <b>{pcLine[0]}</b> <span>{pcLine[1]}</span>
              </p>
            </div>
          </section>
        </div>
      </section>

      <section className="ci-how" aria-labelledby="ci-how-h">
        <h2 id="ci-how-h">{t("ci.how")}</h2>
        <ol>
          <li>
            <p>
              <b>{t(session ? "ci.how1" : "ci.how1Join")}</b>
              <span>{t("ci.how1Line")}</span>
            </p>
          </li>
          <li>
            <p>
              <b>
                {session ? t("ci.how2", { day: sessionWeekday(lang, session.at, "long") }) : t("ci.how2Any")}
              </b>
              <span>{t("ci.how2Line")}</span>
            </p>
          </li>
          <li>
            <p>
              <b>{t("ci.how3")}</b>
              <span>{t("ci.how3Line")}</span>
            </p>
          </li>
        </ol>
      </section>
    </main>
  );
}

/** Someone's answer to the Zockrunde as the ticket shows it: in, can't, or still open. */
function Answer({ rsvp }: { rsvp: Rsvp | null }) {
  const { t } = useCrewText();
  return (
    <span className={`gc-ans ${rsvp ?? ""}`}>
      <span className="d" aria-hidden="true">
        {rsvp === "yes" ? <Tick /> : null}
      </span>
      {t(rsvp === "yes" ? "g.ansYes" : rsvp === "no" ? "g.ansNo" : "g.ansOpen")}
    </span>
  );
}
