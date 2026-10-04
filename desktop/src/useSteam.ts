import { useEffect, useRef, useState } from "react";
import type { SteamRead } from "../steam.cjs";
import { bridge } from "./bridge";
import type { Installer, SteamSetup } from "./model";

/** How often Steam is read while something is under way: an install, or the installer open. */
export const BUSY_MS = 2_000;
/** How often otherwise, so signing in or installing Steam shows without a click. */
export const IDLE_MS = 8_000;
/** A game sent to Steam that it has not started by then was turned down in Steam's window. */
export const ASKED_FOR_MS = 10 * 60_000;

/**
 * Steam on this PC, read through main (steam.cjs): installed, signed in, and
 * the games it is installing. `installed` are the appids the app already
 * lists; `onChanged` is called when Steam has just been installed or an
 * install has just left Steam's list, so the caller reads the games again.
 */
export function useSteam({
  installed,
  onChanged,
}: {
  installed: number[];
  onChanged: () => void;
}): SteamSetup & { installSteam(): void; askInstall(appid: number): void } {
  const [read, setRead] = useState<SteamRead | null>(null);
  const [installer, setInstaller] = useState<Installer>({ kind: "idle" });
  /** Appid → when the owner sent it to Steam. */
  const [asked, setAsked] = useState<ReadonlyMap<number, number>>(new Map());
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // The next read is paced by what is under way once this one is done: an
  // install it found, the installer open, or a game the owner sent to Steam.
  const waiting = useRef(false);
  waiting.current = installer.kind === "opened" || asked.size > 0;
  useEffect(() => {
    const host = bridge();
    if (!host) return;
    let current = true;
    let timer = 0;
    const tick = () =>
      void host
        .readSteam()
        .then((next) => {
          if (current) setRead(next);
          return next.installs.length > 0;
        })
        .catch(() => false)
        .then((installing) => {
          if (current) timer = window.setTimeout(tick, installing || waiting.current ? BUSY_MS : IDLE_MS);
        });
    tick();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, []);

  // Steam just installed, or a game just finished (or was dropped): the games list is stale.
  const last = useRef<SteamRead | null>(null);
  useEffect(() => {
    const before = last.current;
    last.current = read;
    if (!before || !read) return;
    const left = before.installs.some((i) => !read.installs.some((n) => n.appid === i.appid));
    if ((read.installed && !before.installed) || left) changed.current();
  }, [read]);

  // Once Steam is installed, the installer has done its job.
  useEffect(() => {
    if (read?.installed) setInstaller((was) => (was.kind === "opened" ? { kind: "idle" } : was));
  }, [read?.installed]);

  // A game stops being waited for once Steam starts it, it is installed, or the wait runs out.
  const listed = installed.join(",");
  useEffect(() => {
    setAsked((was) => {
      const now = Date.now();
      const next = new Map(
        [...was].filter(
          ([appid, at]) =>
            now - at < ASKED_FOR_MS &&
            !read?.installs.some((i) => i.appid === appid) &&
            !installed.includes(appid),
        ),
      );
      return next.size === was.size ? was : next;
    });
  }, [read, listed]);

  return {
    status: read && {
      installed: read.installed,
      running: read.running,
      signedIn: read.signedIn,
    },
    installer,
    installs: read?.installs ?? [],
    asked: [...asked.keys()],
    installSteam: () => {
      const host = bridge();
      if (!host || installer.kind === "fetching") return;
      setInstaller({ kind: "fetching" });
      void host
        .installSteam()
        .catch(() => "Steam's installer could not be downloaded. Try again.")
        .then((error) => setInstaller(error ? { kind: "failed", error } : { kind: "opened" }));
    },
    askInstall: (appid) => setAsked((was) => new Map(was).set(appid, Date.now())),
  };
}
