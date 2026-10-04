import { useCallback, useEffect, useRef, useState } from "react";
import { Backdrop, Button, StatusDot, Tag, TopBar } from "@swiff/ui";
import type { RenterStats } from "@swiff/rtc";
import { Reconnecting } from "./Reconnect";
import { gameArt, gameArtFallbacks, gameTrailer } from "./steam";
import type { Swiff } from "./useSwiff";

/** How long the HUD stays up after the pointer last moved over the stream. */
export const HUD_IDLE_MS = 3_000;

const clock = (ms: number) =>
  [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60]
    .map((n, i) => (i ? String(n).padStart(2, "0") : String(n)))
    .join(":");

/** The HUD's readings: the connection's own, from getStats. A dash until the browser has one. */
export function hudReadings(stats: RenterStats | null) {
  const dash = "–";
  return {
    fps: stats?.fps == null ? dash : String(Math.round(stats.fps)),
    rtt: stats?.rttMs == null ? dash : String(Math.round(stats.rttMs)),
    bitrate: stats?.bitrate == null ? dash : (stats.bitrate / 1_000_000).toFixed(1),
    path: stats?.path === "relayed" ? "Relayed" : stats?.path === "direct" ? "Direct" : null,
  };
}

/**
 * Shown, and a way to show it again: any pointer movement over the session
 * puts the HUD up for HUD_IDLE_MS, and so does focus on its controls. Movement
 * while the stream holds the pointer is the game's, not a wish to see the HUD.
 */
function useAutoHide() {
  const [shown, setShown] = useState(true);
  const timer = useRef<number>();
  const wake = useCallback(() => {
    if (document.pointerLockElement) return;
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), HUD_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);
  return [shown, wake] as const;
}

/** Whether `element` is the page's full-screen element, kept current. */
function useFullscreen(element: HTMLElement | null) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const changed = () =>
      setOn(document.fullscreenElement !== null && document.fullscreenElement === element);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [element]);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void element?.requestFullscreen?.().catch(() => {});
  }, [element]);
  return [on, toggle] as const;
}

/**
 * The running session: the game streamed from the PC, inside Swiff (play.ts),
 * under a HUD of the connection's real numbers that gets out of the way when
 * the pointer rests, with Full screen and End. End ends the booking, which
 * ends the session on the server as the renter's own. In the demo, whose
 * machines are invented, the game's trailer stands in for the stream.
 */
export function Session({ swiff }: { swiff: Swiff }) {
  const { game, picked, elapsedMs, demo, play } = swiff;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [hudShown, wake] = useAutoHide();
  const [fullscreen, toggleFullscreen] = useFullscreen(root);
  const [unmuted, setUnmuted] = useState(false);
  const [refused, setRefused] = useState(false);
  const hushed = useRef(false);
  // Behind Ignition the session can be neither seen, heard nor used; once live,
  // its HUD comes up afresh and its sound is tried, muted again if the browser refuses.
  const behindIgnition = swiff.phase === "connecting";
  useEffect(() => {
    root?.toggleAttribute("inert", behindIgnition);
    const video = root?.querySelector("video");
    if (behindIgnition) {
      // Full screen puts the session above Ignition: leave it, so a stream
      // that reconnects is never seen before its game is on screen again.
      const full = document.fullscreenElement;
      if (full && root?.contains(full)) void document.exitFullscreen?.().catch(() => {});
      if (video) {
        video.muted = true;
        hushed.current = true;
      }
      return;
    }
    wake();
    if (!video || !hushed.current) return;
    hushed.current = false;
    video.muted = false;
    void video.play().catch(() => {
      video.muted = true;
      setRefused(true);
      setUnmuted(false);
      return video.play().catch(() => {});
    });
  }, [root, behindIgnition, wake]);
  if (!game) return null;

  const real = !demo;
  // A session come back to may be on a machine the open game's list no longer shows.
  const host = picked?.name ?? swiff.booking?.machine?.name ?? "your machine";
  // The demo has no connection to read, so it shows what its machine would.
  const readings = real
    ? hudReadings(play?.stats ?? null)
    : {
        fps: picked?.quality.endsWith("120") ? "118" : "59",
        rtt: String(picked?.ping ?? 0),
        bitrate: picked?.quality.startsWith("4K") ? "42" : "28",
        path: null,
      };

  const unmute = () => {
    const video = root?.querySelector("video");
    if (!video) return;
    video.muted = false;
    void video.play().catch(() => {});
    setUnmuted(true);
  };

  return (
    <div
      className="session"
      data-testid="session"
      data-hud={hudShown ? "shown" : "hidden"}
      ref={setRoot}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocus={wake}
    >
      {real ? (
        <video
          className="session-video"
          data-testid="session-video"
          ref={swiff.attachVideo}
          autoPlay
          playsInline
        />
      ) : (
        // The stream stand-in always moves: the wall's motion setting is about
        // the wall, not about the game you are playing.
        <Backdrop image={gameArt(game)} fallback={gameArtFallbacks(game)} video={gameTrailer(game)} motion />
      )}

      <TopBar
        variant="hud"
        className="session-hud"
        start={
          <>
            <StatusDot />
            <strong className="hud-title">{game.title}</strong>
            <span className="hud-on">on {host}</span>
          </>
        }
        end={
          <>
            <span className="hud-stats" data-testid="hud-stats">
              <Tag tone="live">{readings.fps} fps</Tag>
              <Tag>{readings.rtt} ms</Tag>
              <Tag>{readings.bitrate} Mb/s</Tag>
              {readings.path ? <Tag>{readings.path}</Tag> : picked ? <Tag>{picked.quality}</Tag> : null}
            </span>
            <span className="hud-clock">{clock(elapsedMs)}</span>
            <Button variant="secondary" size="sm" onClick={toggleFullscreen}>
              {fullscreen ? "Exit full screen" : "Full screen"}
            </Button>
          </>
        }
      />

      <div className="session-end">
        {(play?.muted || refused) && !unmuted ? (
          <Button variant="secondary" onClick={unmute}>
            Turn sound on
          </Button>
        ) : null}
        <Button variant="secondary" onClick={swiff.endSession}>
          End session
        </Button>
      </div>

      {real ? <Reconnecting swiff={swiff} host={host} /> : null}
    </div>
  );
}
