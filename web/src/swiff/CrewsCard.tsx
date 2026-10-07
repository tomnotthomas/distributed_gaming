// The ways into crews from the rest of the app: the crew card on the profile
// and under an empty wall, the wall's one-line nudge, and the banner every
// screen shows once when a crew the player is in has its first PC.

import { useEffect, useState } from "react";
import { crewTitle, fetchCrews, type MyCrew } from "./crews";
import { useCrewText } from "./crewUi";
import { Glyph } from "./Glyph";
import type { Swiff } from "./useSwiff";

/** The crews the signed-in player is in, read once the card is up; null until then or when unreadable. */
function useMyCrews() {
  const [crews, setCrews] = useState<MyCrew[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetchCrews().then((answer) => {
      if (live) setCrews(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  return crews;
}

/** The crews the player is in, each opening its page, and founding one. */
export function CrewsCard({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const crews = useMyCrews();
  return (
    <section className="ask" aria-labelledby="crews-title" data-testid="crews-card">
      <div className="ask-head">
        <h2 id="crews-title" className="ask-title">
          {t("crews.title")}
        </h2>
        <p className="ask-line">{t("crews.line")}</p>
      </div>
      {crews?.length ? (
        <ul className="ask-members">
          {crews.map((c) => (
            <li key={c.id}>
              <span>
                {crewTitle(lang, c)} ·{" "}
                {t(c.state === "ready" ? "cp.ready" : c.state === "offline" ? "cp.offline" : "cp.almost")}
              </span>
              <button type="button" className="share-link" onClick={() => swiff.openCrew(c.id)}>
                {t("crews.open")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ask-ways">
        <button type="button" className="lpill lpill-sm" onClick={swiff.foundCrew}>
          {crews?.length ? t("crews.new") : t("found.start")}
          <span className="lpill-c">
            <Glyph name="arrow" size={16} />
          </span>
        </button>
      </div>
    </section>
  );
}

const STRIP_KEY = "swiff.crewStripDismissed";

/**
 * The wall's nudge after sign-in: start a crew, or go to the one the player
 * is in, until they say not now. Remembered in this browser only.
 */
export function CrewStrip({ swiff }: { swiff: Swiff }) {
  const { t } = useCrewText();
  const crews = useMyCrews();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STRIP_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(STRIP_KEY, "1");
    } catch {
      // Blocked storage: it is back on the next load, which is harmless.
    }
  };
  const mine = crews?.[0];

  return (
    <div className="library-note ask-strip" data-testid="crew-strip">
      <p>{t("strip.line")}</p>
      <button
        type="button"
        className="lpill lpill-sm"
        onClick={() => (mine ? swiff.openCrew(mine.id) : swiff.foundCrew())}
      >
        {t(mine ? "strip.mine" : "strip.start")}
        <span className="lpill-c">
          <Glyph name="arrow" size={16} />
        </span>
      </button>
      <button type="button" className="share-link ask-later" onClick={dismiss}>
        {t("strip.later")}
      </button>
    </div>
  );
}

/**
 * A crew the player is in has its first PC: a banner on whatever screen they
 * are on (the crew's own page celebrates in place), and, while the tab is in
 * the background and the browser allows it, a notification.
 */
export function CrewReadyBanner({ swiff }: { swiff: Swiff }) {
  const { lang, t } = useCrewText();
  const { crewReady, dismissCrewReady, openCrew, screen, crewRoute } = swiff;
  const [crew, setCrew] = useState<MyCrew | null>(null);

  useEffect(() => {
    if (!crewReady) return;
    let live = true;
    void fetchCrews().then((crews) => {
      const found = crews?.find((c) => c.id === crewReady) ?? null;
      if (!live || !found) return;
      setCrew(found);
      const title = t("ready.crew", { crew: crewTitle(lang, found) });
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(t("brand"), { body: title, tag: `crew-${found.id}` });
        } catch {
          // Some browsers only notify from a service worker: the banner still shows.
        }
      }
    });
    return () => {
      live = false;
    };
  }, [crewReady, lang, t]);

  if (!crewReady || !crew || crew.id !== crewReady) return null;
  if (screen === "crew" && crewRoute.crew === crewReady) return null;
  return (
    <div className="crew-ready crew-ready-float" role="status" data-testid="crew-ready">
      <span className="crew-rays" aria-hidden="true" />
      <b>{t("ready.crew", { crew: crewTitle(lang, crew) })}</b>
      <button
        type="button"
        className="lpill solid"
        onClick={() => {
          openCrew(crew.id);
        }}
      >
        {t("ready.go")}
      </button>
      <button type="button" className="lpill" onClick={dismissCrewReady}>
        {t("ready.close")}
      </button>
    </div>
  );
}
