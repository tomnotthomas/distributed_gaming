// The page Lanterel on a gaming PC opens to pair it with its owner's Steam
// account (/pair?k=<hash>, pair.ts), in the seat invite's look (seat.css): the
// PC as one lit screen with the code its app shows, the owner's one action, and
// three steps. Signed out, the button is Steam sign-in, which comes back here;
// signed in, it adds the PC. Adding always waits for the owner's click, after
// sign-in too: the code is theirs to compare with the app's first. Once the PC
// is added the app carries on by itself.

import { useEffect, useMemo, useState } from "react";
import { LobbyTitle, useCrewText } from "./crewUi";
import { GAMES } from "./data";
import { Glyph } from "./Glyph";
import {
  addPc,
  forgetPair,
  PAIR_PATH,
  pairingCode,
  pairKeyAt,
  rememberedPair,
  rememberPair,
  signInToPair,
  type PairRefusal,
} from "./pair";
import { endSignIn, gameArt } from "./steam";
import type { Swiff } from "./useSwiff";

/** The key art behind the page: the seat invite's, so the two read as one family. */
const ART = GAMES.find((g) => g.id === "cs")!;

/** Where the owner stands: added, refused, no answer, or nothing yet. */
type Outcome = { machineId: string } | PairRefusal | "failed" | "sign-out-failed" | "storage-blocked" | null;

/** The pill's arrow. */
const Arrow = () => (
  <span className="lpill-c">
    <Glyph name="arrow" size={18} />
  </span>
);

export function PairPc({ swiff }: { swiff: Swiff }) {
  const { t } = useCrewText();
  const { signedIn, signInKnown, openCrew, goHome } = swiff;
  // Read once: from the address the app opened, or from this tab, back from Steam sign-in at plain /pair.
  const k = useMemo(() => pairKeyAt(location.pathname, location.search) || rememberedPair(), []);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  // The hash leaves the address bar and history once this tab holds it; with storage blocked it stays in the query.
  useEffect(() => {
    if (pairKeyAt(location.pathname, location.search) && rememberPair(k)) {
      history.replaceState(history.state, "", PAIR_PATH);
    }
  }, [k]);

  const add = () => {
    setAdding(true);
    setOutcome(null);
    void addPc(k).then((answer) => {
      setAdding(false);
      setOutcome(answer ?? "failed");
      if (answer && typeof answer === "object") {
        forgetPair();
        history.replaceState(history.state, "", PAIR_PATH);
      }
    });
  };
  /** Sign out, then in again with another Steam account, back to this pairing. */
  const otherAccount = () => {
    const signIn = signInToPair(k);
    if (!signIn) return setOutcome("storage-blocked");
    void endSignIn(
      () => location.assign(signIn),
      () => setOutcome("sign-out-failed"),
    );
  };

  if (!k) {
    return (
      <main className="crew-lobby seat-lobby pair-lobby" data-testid="pair">
        <div className="lb-wrap crew-wait crew-gone">
          <h1>{t("pr.invalid")}</h1>
          <div className="fa-acts">
            <button type="button" className="lpill" onClick={goHome}>
              {t("pr.toStart")}
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (!signInKnown) {
    return (
      <main className="crew-lobby seat-lobby pair-lobby" data-testid="pair" aria-busy="true">
        <p className="lb-wrap crew-wait">{t("pr.loading")}</p>
      </main>
    );
  }

  const code = pairingCode(k);
  const added = outcome && typeof outcome === "object";
  let action;
  if (added) {
    action = (
      <>
        <p role="status">{t("pr.doneLine")}</p>
        <button type="button" className="lpill solid" onClick={() => openCrew()}>
          {t("pr.toCrews")}
          <Arrow />
        </button>
      </>
    );
  } else if (outcome === "paired-elsewhere" || outcome === "too-many" || outcome === "sign-out-failed") {
    const line = {
      "paired-elsewhere": "pr.elsewhere",
      "too-many": "pr.tooMany",
      "sign-out-failed": "pr.signOutFailed",
    } as const;
    action = (
      <>
        <p role="alert">{t(line[outcome])}</p>
        <button type="button" className="lpill solid" onClick={otherAccount}>
          {t("pr.otherAccount")}
          <Arrow />
        </button>
      </>
    );
  } else if (outcome === "storage-blocked" || ((!signedIn || outcome === "signed-out") && !signInToPair(k))) {
    // Signing in would carry the hash through Steam: this browser has to keep it instead.
    action = (
      <>
        <p role="alert">{t("pr.storage")}</p>
        <button type="button" className="lpill solid" onClick={() => location.reload()}>
          {t("jn.retry")}
          <Arrow />
        </button>
      </>
    );
  } else if (!signedIn || outcome === "signed-out") {
    action = (
      <a className="lpill solid" href={signInToPair(k) ?? undefined}>
        {t("pr.signIn")}
        <Arrow />
      </a>
    );
  } else {
    action = (
      <>
        <button type="button" className="lpill solid" onClick={add} disabled={adding}>
          {adding ? t("pr.adding") : outcome === "failed" ? t("jn.retry") : t("pr.add")}
          <Arrow />
        </button>
        {outcome === "failed" ? <p role="alert">{t("pr.failed")}</p> : null}
      </>
    );
  }

  return (
    <main
      className="crew-lobby seat-lobby pair-lobby"
      data-testid="pair"
      data-state={added ? "added" : "open"}
    >
      <section className="st-top" aria-labelledby="lb-h1">
        <div className="st-art" aria-hidden="true">
          <img src={gameArt(ART, 2)} alt="" />
        </div>
        <div className="lb-wrap st-grid">
          <div className="st-lead">
            <p className="lb-tag">
              <span>{t("pr.tag")}</span>
            </p>
            <div className="st-title">
              <LobbyTitle prose>
                {added ? (
                  t("pr.done")
                ) : (
                  <>
                    {t("pr.h1")} <b>{t("pr.h1b")}</b>
                  </>
                )}
              </LobbyTitle>
            </div>
            {added ? null : <p className="lead">{t("pr.lead")}</p>}
            <div className="st-acts">{action}</div>
            {!added && !signedIn ? <p className="st-steam">{t("pr.steam")}</p> : null}
          </div>
          <div className="st-room">
            <figure className="st-scr">
              <div className="st-face pr-face">
                <figcaption className="st-cap">{t("pr.screen")}</figcaption>
                <p className="pr-code" aria-label={t("pr.code", { code })}>
                  {code}
                </p>
                {added ? null : <p className="pr-check">{t("pr.codeLine")}</p>}
              </div>
              <span className="st-stand" aria-hidden="true" />
            </figure>
          </div>
        </div>
      </section>

      <div className="lb-wrap">
        <section className="st-sec" aria-labelledby="pr-hh">
          <h2 id="pr-hh">{t("pr.how")}</h2>
          <ol className="st-steps">
            <li>
              <h3>{t("pr.step1")}</h3>
              <p>{t("pr.step1Line")}</p>
            </li>
            <li>
              <h3>{t("pr.step2")}</h3>
              <p>{t("pr.step2Line")}</p>
            </li>
            <li>
              <h3>{t("pr.step3")}</h3>
              <p>{t("pr.step3Line")}</p>
            </li>
          </ol>
        </section>
      </div>
    </main>
  );
}
