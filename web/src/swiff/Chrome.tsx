import { Glyph } from "./Glyph";
import { useScreenText } from "./screenCopy";
import type { Screen } from "./useSwiff";

type Props = {
  screen: Screen;
  onHome: () => void;
  onProfile: () => void;
  /** Share your PC for money; left out while paid gaming is off. */
  onShare?: () => void;
  /** The back chevron, which only the game screen needs. */
  onBack?: () => void;
  /** The live count in the fourth nav cell: "4 free near you". Absent signed out, where none is shown. */
  live?: string | undefined;
  /** A machine just freed up: the live dot rings. */
  freed?: boolean;
  /** Signed in: who, and how much play time they have. Absent signed out. */
  renter?: { persona: string; session: { label: string; onCycle: () => void } };
};

/** "kai_nx" reads as KN: the first letter, and the first after a separator. */
export function initials(persona: string): string {
  const [first = "?", ...rest] = persona.split(/[\s._-]+/).filter(Boolean);
  return (first[0]! + (rest[0]?.[0] ?? "")).toUpperCase();
}

/**
 * The cell strip every renter screen shares: wordmark, four nav cells and the
 * paper account cell, on the same 300 / 1fr / 400 columns as the band below.
 */
export function Chrome({ screen, onHome, onProfile, onShare, onBack, live, freed, renter }: Props) {
  const { t } = useScreenText();
  return (
    <header className="bar">
      <div className="bar-brand">
        {onBack ? (
          <button
            type="button"
            className="bar-home"
            onClick={onBack}
            aria-label={t("bar.back")}
            title={t("bar.backTitle")}
          >
            <Glyph name="back" size={20} />
            <span className="wm">Lanterel</span>
          </button>
        ) : (
          <button type="button" className="bar-home" onClick={onHome} aria-label={t("bar.home")}>
            <span className="wm">Lanterel</span>
          </button>
        )}
      </div>
      <nav className={onShare ? "bar-nav" : "bar-nav bar-nav-3"} aria-label="Lanterel">
        <button type="button" aria-current={screen === "home" ? "page" : undefined} onClick={onHome}>
          {t("bar.home")}
        </button>
        <button type="button" aria-current={screen === "profile" ? "page" : undefined} onClick={onProfile}>
          {t("bar.profile")}
        </button>
        {/* No sharing your PC for money while paid gaming is off: the nav keeps three columns. */}
        {onShare ? (
          <button type="button" aria-current={screen === "share" ? "page" : undefined} onClick={onShare}>
            {t("bar.share")}
          </button>
        ) : null}
        {/* The cell stays when there is no count, so the nav keeps its four columns. */}
        <span className={freed ? "bar-live freed" : "bar-live"}>
          {live ? (
            <>
              <span className="live-dot" />
              {live}
            </>
          ) : null}
        </span>
      </nav>
      <div className="bar-acct">
        {renter ? (
          <>
            <button
              type="button"
              className="acct"
              onClick={onProfile}
              aria-label={t("bar.profileOf", { who: renter.persona || t("bar.signedInLower") })}
            >
              <span className="acct-avatar">{renter.persona ? initials(renter.persona) : "?"}</span>
              <span className="acct-who">
                <b>{renter.persona || t("bar.signedIn")}</b>
                <span>{t("bar.steam")}</span>
              </span>
            </button>
            <button
              type="button"
              className="acct-session"
              onClick={renter.session.onCycle}
              title={t("bar.playTimeTitle")}
            >
              <span className="mono">{t("bar.playTime")}</span>
              <b>{renter.session.label}</b>
            </button>
          </>
        ) : (
          // Signing in is offered once, by the screen below, where you would play.
          <button
            type="button"
            className="acct acct-out"
            onClick={onProfile}
            aria-label={t("bar.profileOut")}
          >
            <span className="mono">{t("bar.notSignedIn")}</span>
          </button>
        )}
      </div>
    </header>
  );
}
