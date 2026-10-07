import { useEffect } from "react";
import { Button, Segment, Surface, Tag } from "@swiff/ui";
import type { CrewHub, CrewHubState, MicMode, MyVoice, WatcherView } from "@swiff/rtc";
import { crewTitle } from "./crews";
import { Glyph } from "./Glyph";
import type { Swiff } from "./useSwiff";
import type { CrewLiveEntry } from "./watch";

/** How many crew sessions the wall's band lists at most. */
const BAND_LIMIT = 3;

/** A person by name, or a stand-in when Steam gave none. */
export const nameOf = (name: string | null | undefined, fallback = "A friend") => name || fallback;

/**
 * The wall's line for each crewmate playing now: who plays what on which
 * machine, and a way to ask to watch (or to watch at once, when they share
 * with the crew). Only ever crewmates: the server lists nobody else.
 */
export function CrewLiveBand({ swiff }: { swiff: Swiff }) {
  const { crewLive, games } = swiff;
  if (!crewLive.length || swiff.demo) return null;
  return (
    <div className="crew-live" data-testid="crew-live">
      {crewLive.slice(0, BAND_LIMIT).map((entry) => (
        <CrewLiveLine
          key={entry.sessionId}
          entry={entry}
          game={games.find((g) => g.appid === entry.gameId)?.title ?? null}
          onWatch={() => swiff.watch(entry)}
        />
      ))}
    </div>
  );
}

/** One crewmate playing now: who, what and where, with Ask to watch (Watch when they share) once their game is on screen. */
function CrewLiveLine({
  entry,
  game,
  onWatch,
}: {
  entry: CrewLiveEntry;
  game: string | null;
  onWatch: () => void;
}) {
  const player = nameOf(entry.player, "Someone in your crew");
  const asked = entry.mine?.state === "asking";
  return (
    <div className="library-note crew-live-line" data-testid="crew-live-line">
      <p>
        <strong>{player}</strong> is {entry.starting ? "starting" : "playing"}{" "}
        {game ? <strong>{game}</strong> : "a game"}
        {entry.machine ? ` on ${entry.machine}` : ""}.
        {entry.watching ? <span className="crew-live-count"> {entry.watching} watching.</span> : null}
      </p>
      {entry.starting ? null : (
        <button type="button" className="lpill lpill-sm" onClick={onWatch} disabled={asked}>
          {asked ? "Asked" : entry.sharing ? "Watch" : "Ask to watch"}
          <span className="lpill-c">
            <Glyph name="arrow" size={16} />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * The voice chat's controls: join (the microphone is asked for then, not
 * before), open mic or push to talk, mute, leave. `pushHint` says how to talk
 * on push to talk besides holding the button.
 */
export function VoiceBar({
  voice,
  mutedBy,
  pushHint,
  onJoin,
  onLeave,
  onMute,
  onMode,
  onTalk,
}: {
  voice: MyVoice;
  /** Who muted this person for everyone, when someone did. */
  mutedBy?: string | null;
  pushHint?: string;
  onJoin: () => void;
  onLeave: () => void;
  onMute: (muted: boolean) => void;
  onMode: (mode: MicMode) => void;
  onTalk: (talking: boolean) => void;
}) {
  if (!voice.inVoice) {
    return (
      <div className="voice-bar" data-testid="voice-bar">
        <Button variant="secondary" size="sm" onClick={onJoin}>
          Join voice
        </Button>
        <p className="voice-note">
          {voice.micRefused
            ? "Swiff couldn't use your microphone. Allow it in the browser and try again."
            : "Your microphone is used only once you join. Nothing is recorded."}
        </p>
      </div>
    );
  }
  const live = !voice.muted && !mutedBy && (voice.mode === "open" || voice.talking);
  return (
    <div className="voice-bar" data-testid="voice-bar" data-live={live ? "" : undefined}>
      <Segment<MicMode>
        name="mic-mode"
        aria-label="How you talk"
        value={voice.mode}
        onChange={onMode}
        options={[
          { value: "open", label: "Open mic" },
          { value: "push", label: "Push to talk" },
        ]}
      />
      <div className="voice-row">
        {voice.mode === "push" ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm voice-talk"
            aria-pressed={voice.talking}
            disabled={voice.muted || Boolean(mutedBy)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              onTalk(true);
            }}
            onPointerUp={() => onTalk(false)}
            onPointerCancel={() => onTalk(false)}
            onKeyDown={(e) => (e.key === " " || e.key === "Enter") && onTalk(true)}
            onKeyUp={(e) => (e.key === " " || e.key === "Enter") && onTalk(false)}
          >
            {voice.talking ? "Talking" : "Hold to talk"}
          </button>
        ) : null}
        <Button variant="secondary" size="sm" aria-pressed={voice.muted} onClick={() => onMute(!voice.muted)}>
          {voice.muted ? "Unmute" : "Mute"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onLeave}>
          Leave voice
        </Button>
      </div>
      <p className="voice-note" aria-live="polite">
        {mutedBy
          ? `${mutedBy} muted you.`
          : voice.muted
            ? "You're muted."
            : voice.mode === "push"
              ? voice.talking
                ? "Your crew hears you."
                : (pushHint ?? "Hold the button to talk.")
              : "Your crew hears you."}
      </p>
    </div>
  );
}

/**
 * The player's say over who watches, over the stream: a crewmate asking is
 * shown at once, whatever the HUD is doing, with Let them watch and Not now;
 * below the HUD's controls, who watches, each with Stop and mute, sharing with
 * the crew, and the voice chat. Every key still goes to the game: nothing here
 * takes the keyboard, so push to talk is the button alone.
 */
export function CrewOverlay({ hub, crew }: { hub: CrewHub; crew: CrewHubState | null }) {
  const watchers = crew?.watchers ?? [];
  const asking = watchers.filter((w) => w.state === "asking" && w.here);
  const watching = watchers.filter((w) => w.state === "watching");
  const crews = crew?.crews ?? [];
  const named = crew?.crew
    ? crewTitle("en", { crewName: crew.crew.name, name: crew.crew.admin, own: false })
    : null;
  const voice = crew?.voice ?? {
    inVoice: false,
    muted: false,
    mode: "open",
    talking: false,
    micRefused: false,
  };
  return (
    <>
      {asking.length ? (
        <div className="crew-asks" role="region" aria-label="Asking to watch" data-testid="crew-asks">
          {asking.map((w) => (
            <Surface key={w.watchId} strength="strong" padding="md" className="crew-ask" role="group">
              <p>
                <strong>{nameOf(w.name)}</strong> would like to watch you play.
              </p>
              <div className="crew-ask-actions">
                <Button size="sm" onClick={() => hub.answer(w.watchId, true)}>
                  Let them watch
                </Button>
                <Button variant="ghost" size="sm" onClick={() => hub.answer(w.watchId, false)}>
                  Not now
                </Button>
              </div>
            </Surface>
          ))}
        </div>
      ) : null}

      <Surface padding="md" className="crew-panel session-crew" data-testid="crew-panel">
        <div className="crew-head">
          <strong>Crew</strong>
          <span className="crew-count">
            {watching.length ? `${watching.length} watching` : "Nobody watching"}
          </span>
        </div>
        {watching.length ? (
          <ul className="crew-people" aria-label="Watching you">
            {watching.map((w) => (
              <WatcherRow key={w.watchId} watcher={w} hub={hub} />
            ))}
          </ul>
        ) : (
          <p className="crew-empty">
            {!named
              ? "Nobody can watch this session: this PC doesn't play for a crew of yours."
              : crew?.sharing
                ? `Anyone in ${named} can watch now.`
                : `Friends in ${named} can ask to watch. Or share and let them in.`}
          </p>
        )}
        {crews.length > 1 ? (
          <Segment<string>
            name="watch-crew"
            aria-label="Which crew may watch"
            value={crew?.crew?.id ?? ""}
            onChange={(id) => hub.share(crew?.sharing ?? false, id)}
            options={crews.map((c) => ({
              value: c.id,
              label: crewTitle("en", { crewName: c.name, name: c.admin, own: false }),
            }))}
          />
        ) : null}
        {named || crew?.sharing ? (
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={crew?.sharing ?? false}
            onClick={() => hub.share(!crew?.sharing)}
          >
            {crew?.sharing ? "Stop sharing with crew" : "Share with my crew"}
          </Button>
        ) : null}
        <VoiceBar
          voice={voice}
          onJoin={() => void hub.joinVoice()}
          onLeave={hub.leaveVoice}
          onMute={hub.setMuted}
          onMode={hub.setMode}
          onTalk={hub.setTalking}
        />
      </Surface>
    </>
  );
}

/** One viewer in the player's panel: asking or watching, in the voice chat or not, with the player's say over them. */
function WatcherRow({ watcher, hub }: { watcher: WatcherView; hub: CrewHub }) {
  const name = nameOf(watcher.name);
  return (
    <li data-testid="crew-watcher">
      <span className="crew-name">{name}</span>
      <span className="crew-tags">
        {!watcher.connected ? <Tag>Connecting</Tag> : null}
        {watcher.mutedByPlayer ? (
          <Tag>Muted for all</Tag>
        ) : watcher.inVoice ? (
          <Tag tone="live">{watcher.muted ? "Muted" : "In voice"}</Tag>
        ) : null}
      </span>
      <span className="crew-actions">
        {watcher.inVoice && !watcher.mutedByPlayer ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={watcher.mutedForMe}
            onClick={() => hub.muteForMe(watcher.watchId, !watcher.mutedForMe)}
          >
            {watcher.mutedForMe ? "Hear" : "Mute for me"}
          </Button>
        ) : null}
        {watcher.inVoice || watcher.mutedByPlayer ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => hub.muteForAll(watcher.watchId, !watcher.mutedByPlayer)}
          >
            {watcher.mutedByPlayer ? "Let them talk" : "Mute for all"}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => hub.stop(watcher.watchId)}>
          Stop
        </Button>
      </span>
    </li>
  );
}

/** Hold `key` to talk while `on`, unless typing in a field. Releases when the page loses focus. */
export function usePushKey(key: string, on: boolean, onTalk: (talking: boolean) => void) {
  useEffect(() => {
    if (!on) return;
    /** Whether the key went to a text field, where it types rather than talks. */
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]") !== null;
    /** The push-to-talk key goes down: talk. */
    const down = (e: KeyboardEvent) => {
      if (e.code !== key || e.repeat || typing(e)) return;
      onTalk(true);
    };
    /** The push-to-talk key comes up: stop talking. */
    const up = (e: KeyboardEvent) => {
      if (e.code === key) onTalk(false);
    };
    /** The page lost focus with the key held: stop talking. */
    const blur = () => onTalk(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      onTalk(false);
    };
  }, [key, on, onTalk]);
}
