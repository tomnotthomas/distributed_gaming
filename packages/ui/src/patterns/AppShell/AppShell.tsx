import type { ComponentProps, ReactNode } from "react";
import { Avatar } from "../../primitives/Avatar";
import { IconButton } from "../../primitives/IconButton";
import { Pill } from "../../primitives/Pill";
import { TopBar } from "../../primitives/TopBar";
import "./AppShell.css";

type Props = {
  onHome: () => void;
  onProfile: () => void;
  /** The back arrow, which only the game screen needs. */
  onBack?: () => void;
  /** How long you have tonight. Absent until a library is connected. */
  session?: { label: string; onCycle: () => void };
  avatar: { initial: string; ring?: ComponentProps<typeof Avatar>["ring"]; label: string };
  /** Ambient wash behind everything, tinted by whatever tile you are hovering. */
  tint?: string;
  /** The game screen floats the header over its own full-bleed hero. */
  floating?: boolean;
  children: ReactNode;
};

/** Brand, back, session, avatar — the chrome every screen shares. */
export function AppShell({ onHome, onProfile, onBack, session, avatar, tint, floating, children }: Props) {
  return (
    <div className="app">
      <div className="app-tint" style={{ background: tint, opacity: tint ? 1 : 0 }} />
      <TopBar
        floating={floating}
        start={
          <>
            <button type="button" className="brand" onClick={onHome} aria-label="Home">
              <span className="brand-mark">L</span>
              <span>Lanterel</span>
            </button>
            {onBack ? (
              <IconButton
                icon="arrow-left"
                label="Back to all games"
                title="All games · Esc"
                className="enter-fade"
                onClick={onBack}
              />
            ) : null}
          </>
        }
        end={
          <>
            {session ? (
              <Pill
                label="Tonight"
                onClick={session.onCycle}
                title="How long do you have tonight? Ready means a machine is free for the whole time."
              >
                {session.label}
              </Pill>
            ) : null}
            <button type="button" className="avatar-btn" onClick={onProfile} aria-label={avatar.label}>
              <Avatar initial={avatar.initial} ring={avatar.ring ?? "idle"} />
            </button>
          </>
        }
      />
      {children}
    </div>
  );
}
