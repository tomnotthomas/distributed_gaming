import { Glyph } from "./Glyph";
import type { Screen } from "./useSwiff";

type Props = {
  screen: Screen;
  onHome: () => void;
  onProfile: () => void;
  onShare: () => void;
  /** The back chevron, which only the game screen needs. */
  onBack?: () => void;
  /** The live count in the fourth nav cell: "4 free near you". Absent signed out, where none is shown. */
  live?: string | undefined;
  /** A machine just freed up: the live dot rings. */
  freed?: boolean;
  /** Signed in: who, and how long they have tonight. Absent signed out. */
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
  return (
    <header className="bar">
      <div className="bar-brand">
        {onBack ? (
          <button
            type="button"
            className="bar-home"
            onClick={onBack}
            aria-label="Back to all games"
            title="All games · Esc"
          >
            <Glyph name="back" size={20} />
            <span className="wm">Swiff</span>
          </button>
        ) : (
          <button type="button" className="bar-home" onClick={onHome} aria-label="Home">
            <span className="wm">Swiff</span>
          </button>
        )}
      </div>
      <nav className="bar-nav" aria-label="Swiff">
        <button type="button" aria-current={screen === "home" ? "page" : undefined} onClick={onHome}>
          Home
        </button>
        <button type="button" aria-current={screen === "profile" ? "page" : undefined} onClick={onProfile}>
          Profile
        </button>
        <button type="button" aria-current={screen === "share" ? "page" : undefined} onClick={onShare}>
          Share your PC
        </button>
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
              aria-label={`Profile, ${renter.persona || "signed in"}`}
            >
              <span className="acct-avatar">{renter.persona ? initials(renter.persona) : "?"}</span>
              <span className="acct-who">
                <b>{renter.persona || "Signed in"}</b>
                <span>Steam connected</span>
              </span>
            </button>
            <button
              type="button"
              className="acct-session"
              onClick={renter.session.onCycle}
              title="How long do you have tonight? Ready means a machine is free for the whole time."
            >
              <span className="mono">Tonight</span>
              <b>{renter.session.label}</b>
            </button>
          </>
        ) : (
          // Signing in is offered once, by the screen below, where you would play.
          <button
            type="button"
            className="acct acct-out"
            onClick={onProfile}
            aria-label="Profile, not signed in"
          >
            <span className="mono">Not signed in</span>
          </button>
        )}
      </div>
    </header>
  );
}
