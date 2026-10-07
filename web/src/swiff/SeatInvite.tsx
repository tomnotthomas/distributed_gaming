// The page a friend seat's link opens (/seat/<token>), in the approved seat
// invite look (seat.css): whose PC, the seat held for the friend on its
// screen, the facts as a pass, and three steps. Signed out, the button is
// Steam sign-in, which comes back here and takes the seat at once; signed in,
// it takes it. Either way the friend lands on the crew the seat is in, and
// plays their own Steam games on that PC, signed in as themselves.

import { useEffect, useMemo, useRef, useState } from "react";
import { possessive } from "./crewCopy";
import { Avatar, LobbyTitle, useCrewText } from "./crewUi";
import { GAMES } from "./data";
import { Glyph } from "./Glyph";
import {
  cameBackToTake,
  daysLeft,
  forgetSeat,
  meanToTake,
  openSeat,
  rememberedSeat,
  rememberSeat,
  SEAT_PATH,
  seatTokenAt,
  signInForSeat,
  takeSeat,
  type Seat,
  type SeatRefusal,
} from "./seat";
import { gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

/** The art on the PC's screen: Counter-Strike 2's, free to play, so nobody is shown a game they cannot have. */
const ART = GAMES.find((g) => g.id === "cs")!;

/** Where the friend stands: reading the seat, a link that opens nothing, no answer, or the seat. */
type Opened = Seat | "invalid" | "unanswered" | null;

export function SeatInvite({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  // Back from "Grab your seat" via Steam: the tab noted it was going there to take it, which counts once.
  const fromSignIn = useMemo(() => seatTokenAt(location.pathname) === "" && cameBackToTake(), []);
  const token = useMemo(() => seatTokenAt(location.pathname) || rememberedSeat(), []);
  const { signedIn, signInKnown, openCrew, goHome } = swiff;
  const [opened, setOpened] = useState<Opened>(token ? null : "invalid");
  const [taking, setTaking] = useState(false);
  const [refused, setRefused] = useState<SeatRefusal | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const tookOnce = useRef(false);

  // The token leaves the address bar and history once this tab holds it; with storage blocked it stays in the path.
  useEffect(() => {
    if (seatTokenAt(location.pathname) && rememberSeat(token)) {
      history.replaceState(history.state, "", SEAT_PATH + location.search);
    }
  }, [token]);

  // Read again once sign-in is known: whether the seat is theirs depends on it.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void openSeat(token).then((answer) => {
      if (live) setOpened(answer ?? "unanswered");
    });
    return () => {
      live = false;
    };
  }, [token, signedIn, attempt]);

  const take = () => {
    setTaking(true);
    setRefused(null);
    void takeSeat(token).then((answer) => {
      setTaking(false);
      if (answer === "invalid") setOpened("invalid");
      else if (answer === null) setRefused("failed");
      else if ("refused" in answer) {
        setRefused(answer.refused);
        // Someone else's now, or run out: the page shows it as it is.
        setAttempt((n) => n + 1);
      } else {
        forgetSeat();
        openCrew(answer.crewId);
      }
    });
  };

  // Back from Steam sign-in: take the seat without asking twice.
  useEffect(() => {
    if (!fromSignIn || !signInKnown || !signedIn || tookOnce.current) return;
    if (!opened || typeof opened !== "object" || opened.state !== "open") return;
    tookOnce.current = true;
    take();
    // take reads only the token, which never changes.
  }, [fromSignIn, signInKnown, signedIn, opened]);

  if (opened === "invalid" || opened === "unanswered") {
    return (
      <main className="crew-lobby seat-lobby" data-testid="seat">
        <div className="lb-wrap crew-wait crew-gone">
          <h1>{t(opened === "invalid" ? "st.invalid" : "st.unanswered")}</h1>
          {opened === "invalid" ? <p>{t("st.askAnon")}</p> : null}
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
      <main className="crew-lobby seat-lobby" data-testid="seat" aria-busy="true">
        <p className="lb-wrap crew-wait">{t("st.loading")}</p>
      </main>
    );
  }

  const seat = opened;
  const host = seat.host ?? t("st.someone");
  // The PC by its owner, else by the name its host gave it; plainly, in the sentence's own case, when neither is known.
  const pcName = seat.host ? possessive(lang, "pc.of", seat.host) : seat.pc.name;
  const pcTitle = pcName ?? t("st.pcAnon");
  const pc = pcName ?? t("st.pcAnonIn");
  const days = daysLeft(seat.expiresAt);
  const ranOut = seat.state === "host" && seat.expiresAt <= Date.now();
  const stub =
    seat.state === "open" || (seat.state === "host" && !ranOut)
      ? t(days === 1 ? "st.stubOne" : "st.stub", { friend: seat.friend, n: days })
      : seat.state === "yours"
        ? t("st.stubYours", { friend: seat.friend })
        : t(seat.state === "taken" ? "st.stubTaken" : "st.stubExpired");
  const until = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "long",
  }).format(seat.expiresAt);
  const now = { ready: "st.nowReady", busy: "st.nowBusy", offline: "st.nowOffline" } as const;
  const ask = seat.host ? { name: seat.host } : null;

  const takeButton = !signedIn ? (
    <a className="lpill solid" href={signInForSeat(token)} onClick={() => meanToTake()}>
      {t("st.take")}
      <span className="lpill-c">
        <Glyph name="arrow" size={18} />
      </span>
    </a>
  ) : (
    <button type="button" className="lpill solid" onClick={take} disabled={taking}>
      {taking ? t("st.taking") : t("st.take")}
      <span className="lpill-c">
        <Glyph name="arrow" size={18} />
      </span>
    </button>
  );

  let action;
  if (seat.state === "yours") {
    action = (
      <>
        <p role="status">{t("st.yours")}</p>
        <button type="button" className="lpill solid" onClick={() => openCrew(seat.crewId ?? undefined)}>
          {t("st.toCrew")}
          <span className="lpill-c">
            <Glyph name="arrow" size={18} />
          </span>
        </button>
      </>
    );
  } else if (seat.state === "host") {
    action = <p role="status">{ranOut ? t("st.expired") : t("st.host", { friend: seat.friend })}</p>;
  } else if (seat.state === "taken" || seat.state === "expired") {
    action = (
      <>
        <p role="status">
          {t(seat.state === "taken" ? "st.taken" : "st.expired")}{" "}
          {ask ? t(seat.state === "taken" ? "st.takenLine" : "st.expiredLine", ask) : t("st.askAnon")}
        </p>
        <button type="button" className="lpill" onClick={goHome}>
          {t("jn.back")}
        </button>
      </>
    );
  } else {
    action = takeButton;
  }

  return (
    <main className="crew-lobby seat-lobby" data-testid="seat" data-state={seat.state}>
      <section className="st-top" aria-labelledby="lb-h1">
        <div className="st-art" aria-hidden="true">
          <img src={gameArt(ART, 2)} alt="" />
        </div>
        <div className="lb-wrap st-grid">
          <div className="st-lead">
            <p className="lb-tag">
              <Avatar name={seat.host} index={0} />
              <span>{t("st.tag")}</span>
            </p>
            <div className="st-title">
              <LobbyTitle prose>
                {t("st.h1", { name: host })} <b>{t("st.h1b")}</b>
              </LobbyTitle>
            </div>
            <p className="lead">{t("st.lead", { name: host })}</p>
            <div className="st-acts">
              {action}
              {refused ? (
                <p role="alert">
                  {refused === "full"
                    ? t("crews.full")
                    : refused === "failed"
                      ? t("st.failed")
                      : refused === "own"
                        ? t("st.host", { friend: seat.friend })
                        : t(refused === "taken" ? "st.taken" : "st.expired")}
                </p>
              ) : null}
            </div>
            {seat.state === "open" ? <p className="st-steam">{t("st.steam")}</p> : null}
          </div>
          <div className="st-room">
            <figure className="st-scr">
              <div className="st-face">
                <img src={gameArt(ART, 2)} alt="" />
                <figcaption className="st-cap">{ART.title}</figcaption>
                <div className="st-stub">
                  <Avatar name={seat.friend} index={1} />
                  <span className="st-stub-name">{stub}</span>
                </div>
              </div>
              <span className="st-stand" aria-hidden="true" />
            </figure>
          </div>
        </div>
      </section>

      <div className="lb-wrap">
        <section className="st-facts" aria-labelledby="st-fh">
          <div>
            <h2 id="st-fh">{pcTitle}</h2>
            {seat.pc.rentalMode ? <p className="st-note">{t("st.noteOs", { pc })}</p> : null}
            <p className="st-note">{t("st.noteOwn")}</p>
          </div>
          <div className="pass">
            <dl className="pass-dl">
              <div>
                <dt>{t("st.seatKey")}</dt>
                <dd>{t("st.seatValue", { n: seat.number, of: seat.of, friend: seat.friend })}</dd>
              </div>
              {seat.pc.gpu ? (
                <div>
                  <dt>{t("st.gpuKey")}</dt>
                  <dd>{seat.pc.gpu}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("st.nowKey")}</dt>
                <dd>{t(now[seat.pc.state])}</dd>
              </div>
              {seat.state === "open" ? (
                <div>
                  <dt>{t("st.untilKey")}</dt>
                  <dd>{until}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("st.priceKey")}</dt>
                <dd>{t("st.price")}</dd>
              </div>
            </dl>
          </div>
        </section>
        <section className="st-sec" aria-labelledby="st-hh">
          <h2 id="st-hh">{t("st.how", { pc })}</h2>
          <ol className="st-steps">
            <li>
              <h3>{t("st.step1")}</h3>
              <p>{t("st.step1Line")}</p>
            </li>
            <li>
              <h3>{t("st.step2")}</h3>
              <p>{t("st.step2Line", { pc })}</p>
            </li>
            <li>
              <h3>{t("st.step3")}</h3>
              <p>{t("st.step3Line", { pc })}</p>
            </li>
          </ol>
        </section>
      </div>
    </main>
  );
}
