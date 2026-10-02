import { useEffect, useRef, useState } from "react";
import type { PcRead } from "../pc.cjs";
import { bridge } from "./bridge";
import { clock } from "./format";
import { connectionReady, untilChoices, type Connection, type Host, type HostView, type Live } from "./model";
import {
  countSession,
  loadMachineId,
  loadMachineKey,
  loadSessionsToday,
  loadUrl,
  saveMachineId,
  saveMachineKey,
  saveUrl,
} from "./settings";
import { useScreenShare } from "./useScreenShare";

/** How often the clock on the screens moves. Every figure on them is in whole minutes. */
const TICK_MS = 5_000;
/** How often the app checks for someone at the keyboard during a session. */
const INPUT_POLL_MS = 2_000;
/** Input this recent means someone is at the PC; none for this long means they left. */
const AT_PC_S = 5;
const AWAY_S = 60;

type Settings = Pick<Connection, "url" | "machineId" | "machineKey">;

/**
 * This PC's view-model: what the app reads about the PC, the owner's choices,
 * and the live sharing session. The platform does not report demand,
 * reliability, levels, a rate or earnings yet, so those stay null here.
 */
export function useHost(): Host {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // --- the connection the app signs in with
  const [url, setUrl] = useState(loadUrl);
  const [machineId, setMachineId] = useState(loadMachineId);
  const [machineKey, setMachineKey] = useState("");
  const [keyNote, setKeyNote] = useState<string | null>(null);
  useEffect(() => {
    void loadMachineKey().then((saved) => setMachineKey((typed) => typed || saved));
  }, []);

  // --- what the app reads about this PC
  const [pc, setPc] = useState<PcRead | null>(null);
  const [reading, setReading] = useState(true);
  useEffect(() => {
    const host = bridge();
    if (!host) return setReading(false);
    let current = true;
    host
      .readPc()
      .then((read) => current && setPc(read))
      .catch(() => {})
      .finally(() => current && setReading(false));
    return () => {
      current = false;
    };
  }, []);

  const installed = pc?.games ?? [];

  // --- the owner's plan, and the live session
  // Until the owner picks one, the plan is the ~4 hours choice from now.
  const [picked, setPicked] = useState<{ at: number | null } | null>(null);
  const plan = picked ? picked.at : untilChoices(now)[1]!.at;
  const [until, setUntil] = useState<number | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [stopNew, setStopNew] = useState(false);
  const [notify, setNotify] = useState(false);
  const [atPc, setAtPc] = useState(false);
  const [sessionsToday, setSessionsToday] = useState(() => loadSessionsToday(Date.now()));

  const machine = machineId.trim() || "This PC";
  // What the end of a session needs to know, read when it ends rather than when it began.
  const after = useRef({ stopNew, notify, until, machine, stop: () => {} });

  const share = useScreenShare({
    onClaimOver: () => {
      const done = after.current;
      if (done.notify && typeof Notification !== "undefined") {
        new Notification(`${done.machine} is yours again`, { body: "The player's session has ended." });
      }
      setNotify(false);
      setAtPc(false);
      setStopNew(false);
      const passed = done.until !== null && Date.now() >= done.until;
      if (passed) {
        done.stop();
        setNote(`Sharing stopped at ${clock(done.until!)}, as you chose.`);
      } else if (done.stopNew) {
        done.stop();
        setPausedAt(Date.now());
      }
    },
  });
  after.current = { stopNew, notify, until, machine, stop: share.stop };

  // Sharing started, or stopped on its own (a refused key, a closed capture).
  useEffect(() => {
    setSince(share.stream ? Date.now() : null);
  }, [share.stream]);

  // Count each claim once, on the day it came.
  const claimId = share.claim?.sessionId;
  useEffect(() => {
    if (!claimId) return;
    countSession(Date.now());
    setSessionsToday(loadSessionsToday(Date.now()));
  }, [claimId]);

  // The share-until time: no new claims after it. A running session is left to end.
  useEffect(() => {
    if (!share.stream || until === null || now < until || share.claim) return;
    share.stop();
    setNote(`Sharing stopped at ${clock(until)}, as you chose.`);
  }, [now, until, share]);

  // Someone at the keyboard during a session is the owner: the app injects no input.
  useEffect(() => {
    const host = bridge();
    if (!claimId || !host) return setAtPc(false);
    const check = () =>
      void host
        .secondsSinceInput()
        .then((idle) => setAtPc((was) => (idle <= AT_PC_S ? true : idle >= AWAY_S ? false : was)))
        .catch(() => {});
    check();
    const id = window.setInterval(check, INPUT_POLL_MS);
    return () => window.clearInterval(id);
  }, [claimId]);

  const begin = async (settings: Settings, end: number | null) => {
    if (end !== null && end <= Date.now()) {
      setNote(`${clock(end)} has passed. Choose a later time.`);
      return;
    }
    // Starting again (new settings while offline) replaces the capture rather than adding one.
    if (share.stream) share.stop();
    setStarting(true);
    setNote(null);
    setStopNew(false);
    setUntil(end);
    const ok = await share.start(settings.url, {
      machineId: settings.machineId.trim(),
      machineKey: settings.machineKey.trim(),
    });
    setStarting(false);
    if (ok) setPausedAt(null);
  };

  const live = ((): Live => {
    if (pausedAt !== null) return { kind: "paused", at: pausedAt };
    if (!share.stream) return starting ? { kind: "starting" } : { kind: "off", note };
    if (share.claim) {
      const { appid, minutes, at } = share.claim;
      const name = installed.find((g) => g.appid === appid)?.name ?? `Steam app ${appid}`;
      return {
        kind: "session",
        since: since ?? at,
        until,
        claim: { appid, name, minutes, at, rate: null },
        playerHere: share.peerHere,
        stopNew,
        notify,
        atPc,
      };
    }
    if (share.connection === "offline") {
      return { kind: "offline", since: share.offlineSince ?? now, lastContact: share.lastContact, until };
    }
    return { kind: "waiting", since: since ?? now, until, registered: share.connection === "registered" };
  })();

  const view: HostView = {
    demo: false,
    now,
    machine,
    pc: { reading, hardware: pc?.hardware ?? null, hardwareRate: null },
    games: { installed, offered: null, demand: null, near: null },
    standing: null,
    earlyEnd: null,
    rate: null,
    earnings: null,
    live,
    plan,
    sessionsToday,
    connection: { url, machineId, machineKey, notice: keyNote ?? share.error, preview: share.stream },
    payoutSaved: false,
  };

  const settings = { url, machineId, machineKey };
  return {
    view,
    actions: {
      plan: (at) => setPicked({ at }),
      goLive: () => {
        if (connectionReady(settings)) void begin(settings, plan);
      },
      setUntil,
      pause: () => {
        if (live.kind !== "waiting") return;
        share.stop();
        setPausedAt(Date.now());
      },
      resume: () => {
        if (live.kind !== "paused") return;
        setPausedAt(null);
        // A share-until time that has passed while paused is not stretched: Go live again.
        if (until === null || until > Date.now()) void begin(settings, until);
      },
      setStopNew,
      notifyAtEnd: () => {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission();
        }
        setNotify(true);
      },
      endEarly: null,
      cancelEnd: null,
      retry: () => {
        if (live.kind === "offline") void share.restart();
      },
      toggleOffer: null,
      saveConnection: async (next) => {
        const key = next.machineKey.trim();
        setUrl(next.url);
        setMachineId(next.machineId);
        setMachineKey(next.machineKey);
        saveUrl(next.url);
        saveMachineId(next.machineId.trim());
        const kept = key ? await saveMachineKey(key) : true;
        setKeyNote(kept ? null : "This system cannot encrypt the key, so it was not saved.");
        if (connectionReady(next)) await begin(next, plan);
      },
      // Payouts are not open: details typed into the form are never sent or kept.
      savePayout: () => {},
    },
  };
}
