import { useEffect, useMemo, useRef, useState } from "react";
import type { PcRead } from "../pc.cjs";
import { bridge } from "./bridge";
import { demandRows, useDemand } from "./demand";
import { clock } from "./format";
import { connectionReady, untilChoices, type Connection, type Host, type HostView, type Live } from "./model";
import { createHostReporter, hostReport, type Crew, type HostReporter } from "./report";
import {
  countSession,
  loadMachineId,
  loadMachineKey,
  loadName,
  loadNotOffered,
  loadSessionsToday,
  loadUrl,
  saveMachineId,
  saveMachineKey,
  saveName,
  saveNotOffered,
  saveUrl,
  toSocketUrl,
} from "./settings";
import { useRental } from "./useRental";
import { useScreenShare } from "./useScreenShare";
import { useSteam } from "./useSteam";

/** How often the clock on the screens moves. Every figure on them is in whole minutes. */
const TICK_MS = 5_000;
/** How often the app checks for someone at the keyboard during a session. */
const INPUT_POLL_MS = 2_000;
/** Input this recent means someone is at the PC; none for this long means they left. */
const AT_PC_S = 5;
const AWAY_S = 60;

type Settings = Pick<Connection, "url" | "machineId" | "machineKey">;

/**
 * This PC's view-model: what the app reads about the PC and its Steam, what
 * renters ask for, the owner's choices, and the live sharing session. While it
 * shares, the app reports this PC to the platform (report.ts): its parts, the
 * games the owner offers, the share-until time, and a beat every 5 s. The
 * platform does not report reliability, levels, a rate or earnings yet, so
 * those stay null here.
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
  const [name, setName] = useState(loadName);
  const [machineKey, setMachineKey] = useState("");
  const [keyNote, setKeyNote] = useState<string | null>(null);
  useEffect(() => {
    void loadMachineKey().then((saved) => setMachineKey((typed) => typed || saved));
  }, []);

  // --- what the app reads about this PC, read again when Steam installs something
  const [pc, setPc] = useState<PcRead | null>(null);
  const [reading, setReading] = useState(true);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const host = bridge();
    if (!host) return setReading(false);
    let current = true;
    host
      .readPc()
      .then((read) => current && setPc(read))
      .catch(() => {})
      .finally(() => current && setReading(false));
    // Games installed or removed later arrive as the whole list.
    const unwatch = host.onGamesChanged((games) => setPc((read) => (read ? { ...read, games } : read)));
    return () => {
      current = false;
      unwatch();
    };
  }, [reads]);

  const installed = pc?.games ?? [];
  const steam = useSteam({
    installed: installed.map((g) => g.appid),
    onChanged: () => setReads((n) => n + 1),
  });
  const demand = useDemand({ url, machineId, machineKey });
  const rental = useRental();

  // --- the games offered: every installed game the owner has not turned off
  const [notOffered, setNotOffered] = useState(loadNotOffered);
  const offered = useMemo(
    () => (pc ? pc.games.filter((g) => !notOffered.has(g.appid)).map((g) => g.appid) : null),
    [pc, notOffered],
  );

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

  const machine = name.trim() || machineId.trim() || "This PC";
  // What the end of a session needs to know, read when it ends rather than when it began.
  const after = useRef({ stopNew, notify, until, machine, stop: () => {} });

  // What reports this PC to the platform while it shares (report.ts), the connection
  // sharing started with, and the call that took the last offer back.
  const sharedWith = useRef<Settings | null>(null);
  const reporter = useRef<HostReporter | null>(null);
  const withdrawn = useRef<Promise<unknown>>(Promise.resolve());

  // A claim for a game not offered is turned down, unless the games are not read yet.
  const offeredNow = useRef(offered);
  offeredNow.current = offered;
  const share = useScreenShare({
    acceptClaim: (claim) => offeredNow.current?.includes(claim.appid) ?? true,
    onRtt: (ms) => reporter.current?.addRtt(ms),
    onClaimRefused: (claim) => {
      console.warn(`[swiff] turned down a claim for Steam app ${claim.appid}, which is not offered`);
    },
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

  // --- what the platform hears about this PC (report.ts)
  const report = useMemo(
    () => hostReport({ name: name.trim() || machineId.trim(), pc, offered }),
    [name, machineId, pc, offered],
  );
  const [upMbps, setUpMbps] = useState<number | null>(null);
  // Who may play on this PC, as the platform says with every answer.
  const [crew, setCrew] = useState<Crew | null>(null);
  const latest = useRef({ report, until, claimed: false });
  latest.current = { report, until, claimed: Boolean(claimId) };

  // Sharing is the offer: from the capture starting to it stopping, for
  // whatever reason (paused, past the share-until time, refused, ended).
  useEffect(() => {
    if (!share.stream || !sharedWith.current) return;
    const mine = createHostReporter(sharedWith.current, {
      report: latest.current.report,
      onUpload: setUpMbps,
      onCrew: setCrew,
      after: withdrawn.current,
    });
    mine.offer(latest.current.until);
    reporter.current = mine;
    return () => {
      reporter.current = null;
      withdrawn.current = mine.withdraw();
    };
  }, [share.stream]);
  useEffect(() => reporter.current?.update(report), [report]);
  useEffect(() => reporter.current?.setUntil(until), [until]);
  useEffect(() => reporter.current?.setBusy(Boolean(claimId)), [claimId]);
  // Quitting the app takes the PC back rather than leaving it to drop offline.
  // A player's session is left to the platform: it ends when the PC goes silent.
  useEffect(() => {
    const quit = () => {
      if (!latest.current.claimed) void reporter.current?.withdraw({ keepalive: true });
    };
    window.addEventListener("pagehide", quit);
    return () => window.removeEventListener("pagehide", quit);
  }, []);

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
    sharedWith.current = {
      url: toSocketUrl(settings.url),
      machineId: settings.machineId.trim(),
      machineKey: settings.machineKey.trim(),
    };
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
    // Offline holds while the client retries: only Swiff confirming the room ends it.
    if (
      share.connection === "offline" ||
      (share.connection === "connecting" && share.offlineSince !== null)
    ) {
      return { kind: "offline", since: share.offlineSince ?? now, lastContact: share.lastContact, until };
    }
    return { kind: "waiting", since: since ?? now, until, registered: share.connection === "registered" };
  })();

  const view: HostView = {
    demo: false,
    now,
    machine,
    pc: { reading, hardware: pc ? { ...pc.hardware, upMbps } : null, hardwareRate: null },
    games: { installed, offered, demand: demand && demandRows(demand, installed), near: null },
    steam: { status: steam.status, installer: steam.installer, installs: steam.installs, asked: steam.asked },
    rental: { reading: rental.reading, read: rental.read, target: rental.target, preview: rental.preview },
    standing: null,
    earlyEnd: null,
    rate: null,
    earnings: null,
    live,
    plan,
    sessionsToday,
    connection: { url, machineId, machineKey, name, notice: keyNote ?? share.error, preview: share.stream },
    payoutSaved: false,
    crew,
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
      toggleOffer: (appid) =>
        setNotOffered((was) => {
          const next = new Set(was);
          if (!next.delete(appid)) next.add(appid);
          saveNotOffered(next);
          return next;
        }),
      saveConnection: async (next) => {
        const key = next.machineKey.trim();
        setUrl(next.url);
        setMachineId(next.machineId);
        setMachineKey(next.machineKey);
        setName(next.name);
        saveUrl(next.url);
        saveMachineId(next.machineId.trim());
        saveName(next.name.trim());
        const kept = key ? await saveMachineKey(key) : true;
        setKeyNote(kept ? null : "This system cannot encrypt the key, so it was not saved.");
        if (connectionReady(next)) await begin(next, live.kind === "off" ? plan : until);
      },
      // Payouts are not open: details typed into the form are never sent or kept.
      savePayout: () => {},
      installSteam: steam.installSteam,
      askInstall: steam.askInstall,
      checkRental: rental.check,
      chooseRentalTarget: rental.choose,
      previewRental: rental.plan,
      closeRentalPreview: rental.close,
      // The platform holds the choice; the screen shows it at once, and the next answer confirms it.
      setCrewOnly: (on) => {
        if (!reporter.current) return;
        reporter.current.setCrewOnly(on);
        setCrew((was) => (was ? { ...was, only: on } : was));
      },
    },
  };
}
