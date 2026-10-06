// The page a crew's link opens (/invite/<token>), in the approved lobby look:
// who asks, which crew, how it works in three lines, and one button. Nothing
// about it asks whether the friend has a gaming PC. Signed out, the button is
// Steam sign-in, which comes back here and joins at once; signed in, it joins.
// Either way the friend lands on the crew's page, where someone who joined is
// shown the PC card first.

import { useEffect, useMemo, useRef, useState } from "react";
import { crewTitle } from "./crews";
import { Avatar, LobbyArt, LobbyTitle, PcIcon, ProgressStops, useCrewText } from "./crewUi";
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
  const fromSignIn = useMemo(() => inviteTokenAt(location.pathname) === "" && cameBackToJoin(), []);
  const token = useMemo(() => inviteTokenAt(location.pathname) || rememberedInvite(), []);
  const { signedIn, signInKnown, openCrew, goHome } = swiff;
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

  const join = () => {
    setJoining(true);
    setJoinFailed(false);
    void joinInvite(token).then((answer) => {
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
    join();
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
            <button type="button" className="lpill" onClick={goHome}>
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
  const button = !signedIn ? (
    <a className="lpill solid" href={signInForInvite(token)} onClick={() => meanToJoin()}>
      {t("jn.joinSteam")}
      <span className="lpill-c">
        <Glyph name="arrow" size={18} />
      </span>
    </a>
  ) : (
    <button type="button" className="lpill solid" onClick={join} disabled={joining}>
      {joining ? t("jn.joining") : t("jn.join")}
      <span className="lpill-c">
        <Glyph name="arrow" size={18} />
      </span>
    </button>
  );
  const others = crew.size - 1;

  return (
    <main className="crew-lobby" data-testid="invite" data-state={crew.state}>
      <section className="lb-lobby" aria-labelledby="lb-h1">
        <LobbyArt />
        <div className="lb-wrap lb-in">
          <div>
            <p className="lb-tag">
              <Avatar name={name} index={0} />
              <span>{t("jn.tag")}</span>
            </p>
            <LobbyTitle prose>
              {name ? t("jn.wants", { name }) : t("jn.invited")} <b>{crewName}</b>.
            </LobbyTitle>
            <p className="lb-state">
              {crew.state === "ready"
                ? crew.pcs > 1
                  ? t("jn.readyMany", { n: crew.pcs })
                  : t("jn.ready")
                : crew.state === "offline"
                  ? t("jn.offline")
                  : t("jn.almost")}
            </p>
          </div>

          <ol className="lb-slots" aria-label={t("jn.slots")}>
            <li className="lb-slot">
              <Avatar name={name} index={0} />
              <span className="lb-who">
                <span className="lb-name">{name ?? crewTitle(lang, crew)}</span>
                <span className="lb-meta">
                  {t("jn.founder")}
                  {others > 0 ? ` · ${t("jn.others", { n: crew.size })}` : ""}
                </span>
              </span>
              <span className="lchip go">{t("cp.readyChip")}</span>
            </li>
            <li className={crew.member ? "lb-slot" : "lb-slot you-wait"}>
              <Avatar name={null} index={1} empty="?" />
              <span className="lb-who">
                <span className="lb-name">{t("jn.yourSeat")}</span>
                <span className="lb-meta">{name ? t("jn.saving", { name }) : t("jn.savingAnon")}</span>
              </span>
              <span className="lchip wait">{t("jn.forYou")}</span>
            </li>
            <li className={crew.pcs ? "lb-slot" : "lb-slot pc"}>
              <span className="av pc" aria-hidden="true">
                <PcIcon />
              </span>
              <span className="lb-who">
                <span className="lb-name">{t("jn.pc")}</span>
                <span className="lb-meta">{t("jn.pcLine")}</span>
              </span>
              <span className={crew.pcs ? "lchip go" : "lchip wait"}>
                {t(crew.pcs ? "jn.pcIn" : "jn.pcOpen")}
              </span>
            </li>
            <li className="lb-slot open">
              <Avatar name={null} index={2} empty="+" />
              <span className="lb-who">
                <span className="lb-name">{t("jn.everyone")}</span>
                <span className="lb-meta">{t("jn.everyoneLine")}</span>
              </span>
              <span className="lchip free">{t("jn.everyoneChip")}</span>
            </li>
          </ol>
          <ProgressStops crew={crew} label={t("cp.progress")} />

          <ol className="jn-three">
            <li>
              <span className="n">1</span>
              <b>{t("jn.step1")}</b>
              <span>{t("jn.step1Line")}</span>
            </li>
            <li>
              <span className="n">2</span>
              <b>{t("jn.step2")}</b>
              <span>{t("jn.step2Line")}</span>
            </li>
            <li>
              <span className="n">3</span>
              <b>{t("jn.step3")}</b>
              <span>{t("jn.step3Line")}</span>
            </li>
          </ol>

          <div className="lb-join">
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
              <>
                {button}
                <p>{t("jn.note")}</p>
              </>
            )}
            {joinFailed ? (
              <p role="alert">{t(joinFailed === "full" ? "crews.full" : "jn.joinFailed")}</p>
            ) : null}
          </div>
        </div>
      </section>

      {crew.member ? null : (
        <div className="lb-wrap">
          <section className="lb-last" aria-labelledby="jn-last-h">
            <div>
              <h2 id="jn-last-h">{name ? t("jn.waiting", { name }) : t("jn.waitingAnon")}</h2>
              <span className="mark" aria-hidden="true" />
            </div>
            <div className="lb-join">{button}</div>
          </section>
        </div>
      )}
    </main>
  );
}
