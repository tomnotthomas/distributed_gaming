import { useCallback, useState } from "react";
import { Button, StatusDot, Surface, Tag, TopBar } from "@swiff/ui";
import { nameOf, usePushKey, VoiceBar } from "./Crew";
import type { Swiff } from "./useSwiff";
import { endedLine, useWatching, type WatchState } from "./watch";

/** The key a viewer holds to talk on push to talk: nothing else on this page reads the keyboard. */
const PUSH_KEY = "KeyV";

/**
 * Watching a crewmate play: their game, view only, with its sound and the
 * crew's voices. It asks first and waits for the player's yes; the player can
 * stop it at any time, and it says so. Nothing typed, clicked or held here
 * reaches the game.
 */
export function Watch({ swiff }: { swiff: Swiff }) {
  const entry = swiff.watching;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [unmuted, setUnmuted] = useState(false);
  const { state, session, muteForMe } = useWatching(entry?.sessionId ?? null, video);
  /** Push to talk, for the push key and the button alike. */
  const talk = useCallback((on: boolean) => session?.setTalking(on), [session]);
  usePushKey(PUSH_KEY, state.voice.inVoice && state.voice.mode === "push", talk);
  if (!entry) return null;

  // Starting a sentence, and within one.
  const player = nameOf(state.player ?? entry.player, "Your friend");
  const them = nameOf(state.player ?? entry.player, "your friend");
  const game = swiff.games.find((g) => g.appid === entry.gameId)?.title ?? null;
  const showing = state.phase === "watching" && state.framed;

  /** Sound on: the browser held it back until the viewer chose it. */
  const unmute = () => {
    if (!video) return;
    video.muted = false;
    void video.play().catch(() => {});
    setUnmuted(true);
  };

  return (
    <div className="session watch" data-testid="watch" data-phase={state.phase}>
      <video
        className="session-video"
        data-testid="watch-video"
        ref={setVideo}
        autoPlay
        playsInline
        hidden={!showing}
      />

      <TopBar
        variant="hud"
        className="session-hud"
        start={
          <>
            {showing ? <StatusDot /> : null}
            <strong className="hud-title">Watching {them}</strong>
            <span className="hud-on">
              {game ?? "their game"}
              {entry.machine ? ` on ${entry.machine}` : ""}
            </span>
            <Tag>View only</Tag>
          </>
        }
        end={
          <Button variant="secondary" size="sm" onClick={swiff.stopWatching}>
            Leave
          </Button>
        }
      />

      {showing ? null : <WatchWait state={state} player={player} them={them} onLeave={swiff.stopWatching} />}

      {state.phase === "watching" ? (
        <Surface padding="md" className="crew-panel" data-testid="watch-crew">
          <div className="crew-head">
            <strong>Voice</strong>
          </div>
          <VoiceRoster state={state} player={player} onMute={muteForMe} />
          <VoiceBar
            voice={state.voice}
            mutedBy={state.voice.mutedByPlayer ? player : null}
            pushHint="Hold V or the button to talk."
            onJoin={() => void session?.joinVoice()}
            onLeave={() => session?.leaveVoice()}
            onMute={(muted) => session?.setMuted(muted)}
            onMode={(mode) => session?.setMode(mode)}
            onTalk={talk}
          />
        </Surface>
      ) : null}

      {showing && state.muted && !unmuted ? (
        <div className="session-end">
          <Button variant="secondary" onClick={unmute}>
            Turn sound on
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Everyone in the voice chat but this viewer, each with a mute of this viewer's own. */
function VoiceRoster({
  state,
  player,
  onMute,
}: {
  state: WatchState;
  player: string;
  onMute: (id: string, muted: boolean) => void;
}) {
  const others = state.roster.filter((p) => p.mid !== null && (p.inVoice || p.mutedByPlayer));
  if (!others.length) return <p className="crew-empty">Nobody is talking yet.</p>;
  return (
    <ul className="crew-people" aria-label="In voice">
      {others.map((p) => {
        const hushed = state.hushed.includes(p.id);
        return (
          <li key={p.id} data-testid="voice-person">
            <span className="crew-name">{p.id === "player" ? player : nameOf(p.name)}</span>
            <span className="crew-tags">
              {p.mutedByPlayer ? <Tag>Muted by {player}</Tag> : p.muted ? <Tag>Muted</Tag> : null}
            </span>
            <span className="crew-actions">
              {!p.mutedByPlayer ? (
                <Button variant="ghost" size="sm" aria-pressed={hushed} onClick={() => onMute(p.id, !hushed)}>
                  {hushed ? "Hear" : "Mute for me"}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What stands in for the picture: asking, waiting for the stream, or why it is over. */
function WatchWait({
  state,
  player,
  them,
  onLeave,
}: {
  state: WatchState;
  player: string;
  them: string;
  onLeave: () => void;
}) {
  let title: string;
  let body: string;
  if (state.phase === "over") {
    title = "Not watching";
    body = endedLine(state.ended, player);
  } else if (state.phase === "asking-server") {
    title = `Asking ${them}`;
    body = "One moment.";
  } else if (state.phase === "asking") {
    title = `Asked ${them}`;
    body = "They see your request over their game, and decide. You watch only if they say yes.";
  } else if (!state.playerHere) {
    title = `Waiting for ${them}`;
    body = "Their connection dropped. Their game shows here again once they're back.";
  } else {
    title = `${player} said yes`;
    body = "Their game shows here in a moment.";
  }
  return (
    <div className="watch-wait" role="status" data-testid="watch-wait">
      <Surface strength="strong" padding="lg" radius="xl" className="watch-card">
        <h2>{title}</h2>
        <p>{body}</p>
        <Button variant={state.phase === "over" ? "primary" : "ghost"} size="sm" onClick={onLeave}>
          {state.phase === "over" ? "Back to the wall" : state.phase === "watching" ? "Leave" : "Cancel"}
        </Button>
      </Surface>
    </div>
  );
}
