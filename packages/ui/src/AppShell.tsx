import type { ReactNode } from "react";
import { Avatar } from "./Avatar";

type Props = {
  onHome: () => void;
  onProfile: () => void;
  /** The back arrow, which only the game screen needs. */
  onBack?: () => void;
  /** How long you have tonight. Absent until a library is connected. */
  session?: { label: string; onCycle: () => void };
  avatar: { initial: string; ring?: "live" | "idle" | "none"; label: string };
  /** Ambient wash behind everything, tinted by whatever tile you are hovering. */
  tint?: string;
  /** The game screen floats the header over its own full-bleed hero. */
  floating?: boolean;
  children: ReactNode;
};

/** Brand, back, session, avatar — the chrome every screen shares. */
export function AppShell({
  onHome,
  onProfile,
  onBack,
  session,
  avatar,
  tint,
  floating,
  children,
}: Props) {
  return (
    <div className="app">
      <div className="app-tint" style={{ background: tint, opacity: tint ? 1 : 0 }} />
      <nav className={floating ? "topbar topbar-float" : "topbar"}>
        <div className="topbar-left">
          <button type="button" className="brand" onClick={onHome} aria-label="Home">
            <span className="brand-mark">S</span>
            <span>Swiff</span>
          </button>
          {onBack ? (
            <button
              type="button"
              className="backbtn glass"
              onClick={onBack}
              aria-label="Back to all games"
              title="All games · Esc"
            >
              <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                <path d="M224 128a8 8 0 0 1-8 8H59.3l58.4 58.3a8 8 0 0 1-11.4 11.4l-72-72a8 8 0 0 1 0-11.4l72-72a8 8 0 0 1 11.4 11.4L59.3 120H216a8 8 0 0 1 8 8Z" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="topbar-right">
          {session ? (
            <button
              type="button"
              className="pill glass"
              onClick={session.onCycle}
              title="How long do you have tonight? Ready means a machine is free for the whole time."
            >
              <span className="pill-label">Tonight</span>
              <span className="pill-value">{session.label}</span>
            </button>
          ) : null}
          <button type="button" className="avatar-btn" onClick={onProfile} aria-label={avatar.label}>
            <Avatar initial={avatar.initial} ring={avatar.ring ?? "idle"} />
          </button>
        </div>
      </nav>
      {children}
    </div>
  );
}
