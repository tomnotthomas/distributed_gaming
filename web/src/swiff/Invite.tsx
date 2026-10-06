import { useEffect, useMemo, useState } from "react";
import { Backdrop } from "@swiff/ui";
import { initials } from "./Chrome";
import { crewText, langOf } from "./crewCopy";
import { GAMES } from "./data";
import { Glyph } from "./Glyph";
import { SignInWithSteam } from "./SignIn";
import {
  inviteTokenAt,
  joinInvite,
  openInvite,
  rememberedInvite,
  signInForInvite,
  type OpenedInvite,
} from "./invite";
import { HOST_DOWNLOAD_URL } from "./SharePC";
import { gameArt, gameArtFallbacks } from "./steam";
import type { Swiff } from "./useSwiff";

/** The invite page's key art: the same as Share your PC's, so the host side reads as one place. */
const ART = GAMES.find((g) => g.id === "er")!;

/** Where the friend stands: reading the invite, a link that opens nothing, or the invite. */
type Opened = OpenedInvite | "invalid" | "unanswered" | null;

/**
 * The page an invite link opens: who asked, and the host side's way in from
 * there. Signing in with Steam and joining puts the friend in the inviter's
 * crew, which makes their PC host that crew alone; then the download and the
 * app's own setup, as on Share your PC.
 */
export function Invite({ swiff }: { swiff: Swiff }) {
  const t = useMemo(() => crewText(langOf()), []);
  const token = useMemo(() => inviteTokenAt(location.pathname) || rememberedInvite(), []);
  const { signedIn } = swiff;
  const [opened, setOpened] = useState<Opened>(token ? null : "invalid");
  const [joining, setJoining] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Read again once sign-in is known: whether it is their own link, or a crew they are in, depends on it.
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
      else if (answer === "own" && typeof opened === "object" && opened) setOpened({ ...opened, own: true });
      else if (answer && typeof answer === "object") {
        setJoined(true);
        if (typeof opened === "object" && opened) setOpened({ ...opened, ...answer.crew, member: true });
      } else setJoinFailed(true);
    });
  };

  if (opened === "invalid") {
    return (
      <main className="share invite-gone" data-testid="invite">
        <h1 className="share-title">{t("invite.invalid")}</h1>
        <p className="share-line">{t("invite.invalidLine")}</p>
        <button type="button" className="lpill lpill-sm" onClick={swiff.goHome}>
          {t("invite.backToWall")}
        </button>
      </main>
    );
  }
  if (opened === "unanswered") {
    return (
      <main className="share invite-gone" data-testid="invite">
        <h1 className="share-title">{t("invite.unanswered")}</h1>
        <button
          type="button"
          className="lpill lpill-sm"
          onClick={() => {
            setOpened(null);
            setAttempt((n) => n + 1);
          }}
        >
          {t("invite.retry")}
        </button>
      </main>
    );
  }

  const crew = opened;
  const name = crew?.name ?? "";
  const own = Boolean(crew?.own);
  // The inviter is in their own crew too; their own link only ever says so.
  const member = Boolean(crew?.member) && !own;
  // The step the friend is on: joining, until they are in; then the download.
  const step = member ? 1 : 0;
  const steps = [
    { b: t("invite.stepJoin"), small: t("invite.stepJoinWhere") },
    { b: t("invite.stepDownload"), small: t("invite.stepDownloadWhere") },
    { b: t("invite.stepLive"), small: t("invite.stepLiveWhere") },
  ];

  return (
    <main className="share invite" data-testid="invite" aria-busy={crew === null}>
      <section className="hero share-hero">
        <Backdrop
          className="hero-art"
          image={gameArt(ART, 2)}
          fallback={gameArtFallbacks(ART)}
          position="62% 35%"
          motion={false}
        />
        <div className="hero-scrim" />

        <div className="share-copy">
          <p className="mono hero-kicker">{name ? t("invite.kicker", { name }) : t("invite.kickerAnon")}</p>
          <h1 className="share-title">{name ? t("invite.title", { name }) : t("invite.titleAnon")}</h1>
          <p className="share-line">{t("invite.line")}</p>

          {member ? (
            <p className="share-line invite-in" role="status">
              {name
                ? t(joined ? "invite.joined" : "invite.member", { name })
                : t(joined ? "invite.joinedAnon" : "invite.memberAnon")}
            </p>
          ) : null}
          <div className="share-actions">
            {crew === null ? (
              <span className="mono share-fine">{t("invite.loading")}</span>
            ) : own ? (
              <p className="share-line" role="status">
                {t("invite.own")}
              </p>
            ) : !signedIn ? (
              <>
                <SignInWithSteam href={signInForInvite(token)} />
                <span className="mono share-fine">{t("invite.signIn")}</span>
              </>
            ) : !member ? (
              <button type="button" className="lpill" onClick={join} disabled={joining}>
                {joining ? t("invite.joining") : t("invite.join")}
                <span className="lpill-c">
                  <Glyph name="arrow" size={18} />
                </span>
              </button>
            ) : HOST_DOWNLOAD_URL ? (
              <>
                <a className="lpill" href={HOST_DOWNLOAD_URL}>
                  {t("invite.download")}
                  <span className="lpill-c">
                    <Glyph name="download" size={18} />
                  </span>
                </a>
                <span className="mono share-fine">Windows, 64-bit</span>
              </>
            ) : (
              <>
                <button type="button" className="lpill" disabled aria-describedby="invite-soon">
                  {t("invite.download")}
                  <span className="lpill-c">
                    <Glyph name="download" size={18} />
                  </span>
                </button>
                <span className="mono share-fine" id="invite-soon">
                  {t("invite.soon")}
                </span>
              </>
            )}
          </div>
          {joinFailed ? (
            <p className="share-line" role="alert">
              {t("invite.joinFailed")}
            </p>
          ) : null}
          {member ? <p className="share-note">{t("invite.note")}</p> : null}
        </div>

        {crew ? (
          <aside
            className="inst inst-lift"
            aria-label={name ? t("invite.title", { name }) : t("invite.titleAnon")}
          >
            <div className="dial-count invite-crew">
              {/* Who asked, by their initials; with no name to go on, how many are in the crew. */}
              <b aria-hidden="true">{name ? initials(name) : crew.size}</b>
              <span className="mono">
                {name ? t("invite.crewSize", { n: crew.size }) : t("invite.inCrew")}
              </span>
            </div>
          </aside>
        ) : null}
      </section>

      <section className="band share-band" aria-label={t("invite.steps")}>
        <div className="share-cell">
          <Glyph name="crew" />
          <h2>{t("invite.crewOnly")}</h2>
          <p>{name ? t("invite.crewOnlyLine", { name }) : t("invite.crewOnlyLineAnon")}</p>
        </div>
        <div className="share-cell">
          <Glyph name="clock" />
          <h2>{t("invite.away")}</h2>
          <p>{t("invite.awayLine")}</p>
        </div>
        <div className="share-cell">
          <Glyph name="lock" />
          <h2>{t("invite.sandbox")}</h2>
          <p>{t("invite.sandboxLine")}</p>
        </div>
        <div className="share-cell share-path">
          <h2 className="mono">{t("invite.steps")}</h2>
          <ol>
            {steps.map((s, i) => (
              <li key={s.b} aria-current={i === step ? "step" : undefined}>
                <b>{s.b}</b>
                <small>{s.small}</small>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
