import { useEffect, useMemo, useRef, useState } from "react";
import { httpOrigin } from "@swiff/rtc";
import type { PcRead } from "../pc.cjs";
import { bridge } from "./bridge";
import { demandRows, useDemand } from "./demand";
import { registerEk, type EkError } from "./ek";
import { WINDOWS_SHARE } from "./devShare";
import { syncErrorProject } from "./errorProject";
import { clock } from "./format";
import { connectionReady, untilChoices, type Connection, type Host, type HostView, type Live } from "./model";
import {
  createHostReporter,
  hostReport,
  offOffer,
  playingFor,
  type Crew,
  type HostReporter,
  type Machine,
} from "./report";
import { rentalReady } from "./rental";
import { seatClient } from "./seats";
import {
  countSession,
  loadMachineId,
  loadMachineKey,
  loadName,
  loadNotOffered,
  loadSessionsToday,
  loadUrl,
  refusedAddress,
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
/**
 * One rental machine's asks of who may play: how many were made, the last
 * answer the platform confirmed and which ask it answered, the latest ask that
 * has answered, the owner's choices on their way, and the retry of a first read
 * that failed.
 */
type CrewAsks = { n: number; confirmed: Crew | null; at: number; done: number; sets: number; retry?: number };
const noCrewAsks = (): CrewAsks => ({ n: 0, confirmed: null, at: 0, done: 0, sets: 0 });
/** A first read of who may play that failed is tried again this much later, once. */
export const CREW_RETRY_MS = 10_000;

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
  // Go live registers this PC's TPM with the server (ek.ts), with the connection as it is then,
  // or says which part of it is missing.
  const ekMachine = useRef<Machine | EkError>("no-machine");
  const rental = useRental({
    registerEk: async (ek) =>
      typeof ekMachine.current === "string"
        ? { ok: false, error: ekMachine.current }
        : registerEk(ekMachine.current, ek),
  });

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
        new Notification(`${done.machine} is yours again`, { body: "The session just ended." });
      }
      setNotify(false);
      setAtPc(false);
      setStopNew(false);
      const passed = done.until !== null && Date.now() >= done.until;
      if (passed) {
        done.stop();
        setNote(`You went offline at ${clock(done.until!)}, as planned.`);
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
    setNote(`You went offline at ${clock(until)}, as planned.`);
  }, [now, until, share]);

  // --- what the platform hears about this PC (report.ts)
  const report = useMemo(
    () => hostReport({ name: name.trim() || machineId.trim(), pc, offered }),
    [name, machineId, pc, offered],
  );
  const [upMbps, setUpMbps] = useState<number | null>(null);
  // Who may play on this PC, as the platform says with every answer, and the
  // owner's choice of crews made while it was off offer, which the next offer carries.
  const [crew, setCrew] = useState<Crew | null>(null);
  const crewChoice = useRef<string[] | null>(null);
  const [crewNote, setCrewNote] = useState<string | null>(null);
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
    if (crewChoice.current !== null) mine.setCrews(crewChoice.current);
    crewChoice.current = null;
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

  // Sharing this Windows desktop is a development path (devShare.ts): the app
  // hosts download goes live through rental mode only.
  const begin = async (settings: Settings, end: number | null) => {
    if (!WINDOWS_SHARE) return;
    if (end !== null && end <= Date.now()) {
      setNote(`${clock(end)} has passed. Pick a later time.`);
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
    rental: {
      reading: rental.reading,
      read: rental.read,
      target: rental.target,
      preview: rental.preview,
      run: rental.run,
      readAt: rental.readAt,
      liveSeen: rental.liveSeen,
      planning: rental.planning,
      bitlockerPage: rental.bitlockerPage,
      removalTried: rental.removalTried,
      download: rental.download,
    },
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
    crewNote,
  };

  const settings = { url, machineId, machineKey };
  // Rental mode's Go live: who may play, read from and set on the platform
  // while this PC is in Windows and so off offer (Swiff OS offers it).
  const socket = toSocketUrl(url);
  const rentalMachine =
    !WINDOWS_SHARE && rentalReady(view.rental) && connectionReady(settings) && !refusedAddress(socket)
      ? { url: socket, machineId: machineId.trim(), machineKey: machineKey.trim() }
      : null;
  // Seats for friends: read and kept on the platform with the machine key, whatever the PC is doing.
  const seatMachine = connectionReady(settings) && !refusedAddress(socket) ? socket : null;
  ekMachine.current =
    seatMachine !== null
      ? { url: seatMachine, machineId: machineId.trim(), machineKey: machineKey.trim() }
      : refusedAddress(socket)
        ? "no-server"
        : "no-machine";
  const seats = useMemo(() => {
    if (seatMachine === null) return null;
    let site: string | null = null;
    try {
      site = httpOrigin(seatMachine);
    } catch {
      return null;
    }
    return seatClient({ url: seatMachine, machineId: machineId.trim(), machineKey: machineKey.trim() }, site);
  }, [seatMachine, machineId, machineKey]);
  // The server's error-reports project, for main and Lanterel OS (errorProject.ts), once per server.
  useEffect(() => {
    if (seatMachine === null) return;
    try {
      void syncErrorProject(httpOrigin(seatMachine));
    } catch {
      // Not an address the platform could answer at; nothing to ask.
    }
  }, [seatMachine]);
  const rentalCrew = useRef(rentalMachine);
  rentalCrew.current = rentalMachine;
  // Each rental machine has its own asks: anything still under way for the one
  // before does nothing. Only the answer to the latest ask counts; a choice that
  // did not save goes back to what the platform last confirmed, and so does the
  // screen when an older choice is confirmed after the latest one failed.
  const crewAsks = useRef<CrewAsks>(noCrewAsks());
  const askCrew = async (crews?: string[]): Promise<boolean> => {
    const machine = rentalCrew.current;
    if (!machine) return false;
    const asks = crewAsks.current;
    const n = ++asks.n;
    if (crews !== undefined) asks.sets++;
    const read = await offOffer(machine, crews);
    if (asks !== crewAsks.current) return true;
    if (crews !== undefined) asks.sets--;
    if (read) window.clearTimeout(asks.retry);
    if (read && n > asks.at) {
      Object.assign(asks, { confirmed: read, at: n });
      if (asks.done === asks.n) setCrew(read);
    }
    if (n !== asks.n) return true;
    asks.done = n;
    if (read) {
      setCrew(read);
      setCrewNote(null);
    } else if (crews !== undefined) {
      setCrew(asks.confirmed);
      setCrewNote("Couldn't save who can play. Try again.");
    }
    return read !== null;
  };
  /** A read of who may play, never once the platform has said or while the owner's choice is on its way. */
  const readCrew = () => {
    if (!crewAsks.current.confirmed && !crewAsks.current.sets) void askCrew();
  };
  useEffect(() => {
    const asks = crewAsks.current;
    setCrew(null);
    setCrewNote(null);
    void askCrew().then((ok) => {
      if (!ok && asks === crewAsks.current && rentalCrew.current)
        asks.retry = window.setTimeout(readCrew, CREW_RETRY_MS);
    });
    return () => {
      window.clearTimeout(asks.retry);
      crewAsks.current = noCrewAsks();
    };
  }, [rentalMachine?.url, rentalMachine?.machineId, rentalMachine?.machineKey]);
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
        setKeyNote(kept ? null : "This PC can't encrypt the key, so it wasn't saved.");
        if (connectionReady(next)) await begin(next, live.kind === "off" ? plan : until);
      },
      // Payouts are not open: details typed into the form are never sent or kept.
      savePayout: () => {},
      installSteam: steam.installSteam,
      askInstall: steam.askInstall,
      checkRental: () => {
        rental.check();
        readCrew();
      },
      chooseRentalTarget: rental.choose,
      downloadImage: rental.downloadImage,
      previewRental: rental.plan,
      closeRentalPreview: rental.close,
      // The platform holds the choice, sent now or with the next offer; the screen
      // shows it at once, and the next answer confirms it. Any pick makes the PC crew-only.
      setCrews: (ids) => {
        setCrewNote(null);
        if (rentalCrew.current) void askCrew(ids);
        else if (reporter.current) reporter.current.setCrews(ids);
        else crewChoice.current = ids;
        setCrew((was) => (was ? playingFor(was, ids) : was));
      },
      seats,
      runRental: rental.start,
      restartRental: rental.restart,
      answerRentalKey: rental.answer,
      saveRecoveryKey: rental.saveRecovery,
      openBitLocker: rental.openBitLocker,
      seenRemoval: rental.seenRemoval,
      finishRemoval: rental.finishRemoval,
      goLiveRental: rental.goLive,
      retryRental: rental.retry,
      reportRental: rental.report,
      seenLastLive: rental.seenLive,
    },
  };
}
