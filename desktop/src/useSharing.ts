import { useEffect, useRef, useState } from "react";
import { startHostSession, type HostConnection, type SessionClaim } from "@swiff/rtc";
import { bridge, type HostBridge } from "./bridge";
import { startHandoff, type HandoffSession, type HandoffStep, type SessionHost } from "./handoff";
import { refusedAddress, toSocketUrl } from "./settings";

export type Credentials = { machineId: string; machineKey: string };

/** A claim, and when this PC heard of it: the booked minutes run from there. */
export type HeldClaim = SessionClaim & { at: number };

export type ShareEvents = {
  /** A claimed session is over, or could not be started: the PC is the owner's again. */
  onClaimOver?: () => void;
  /** Whether to take a claim. One turned down is ended at once and never served. */
  acceptClaim?: (claim: SessionClaim) => boolean;
  onClaimRefused?: (claim: SessionClaim) => void;
  /** A round trip to the server, timed on the signaling socket. */
  onRtt?: (ms: number) => void;
};

/** The session host behind the app window's preload (session-host.cjs). */
export function sessionHostOf(host: HostBridge | undefined): SessionHost {
  if (!host) {
    const missing = async () => {
      throw new Error("a player's session needs the desktop app");
    };
    return { logon: missing, launch: missing, send: () => {}, end: async () => {}, onEvent: () => () => {} };
  }
  return {
    logon: () => host.sessionLogon(),
    launch: (init) => host.sessionLaunch(init),
    send: (command) => void host.sessionSend(command).catch(() => {}),
    end: () => host.sessionEnd(),
    onEvent: (listener) => host.onSessionEvent(listener),
  };
}

/**
 * Hold this PC's room on Swiff while sharing, and hand each claim to a renter's
 * session (handoff.ts). The screen is captured by the session's streamer, not
 * here: this window only holds the machine key and the room.
 */
export function useSharing(events: ShareEvents = {}) {
  // Each start is a new run, so starting again while live begins afresh; 0 is not sharing.
  const [run, setRun] = useState(0);
  const runs = useRef(0);
  const live = run > 0;
  const [session, setSession] = useState<HandoffSession | null>(null);
  const [claim, setClaim] = useState<HeldClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<HostConnection | null>(null);
  /** When Swiff last confirmed the room, and since when it has not been reachable. */
  const [lastContact, setLastContact] = useState<number | null>(null);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const urlRef = useRef("");
  const credentialsRef = useRef<Credentials>({ machineId: "", machineKey: "" });
  const eventsRef = useRef(events);
  eventsRef.current = events;

  /** Resolves true once sharing has started. */
  const start = async (rawUrl: string, credentials: Credentials): Promise<boolean> => {
    setError(null);
    const url = toSocketUrl(rawUrl);
    if (!url) {
      setError("Paste the signaling server address first.");
      return false;
    }
    const refused = refusedAddress(url);
    if (refused) {
      setError(refused);
      return false;
    }
    if (!credentials.machineId || !credentials.machineKey) {
      setError("Fill in this machine's id and key first.");
      return false;
    }
    urlRef.current = url;
    credentialsRef.current = credentials;
    setRun(++runs.current);
    return true;
  };

  const stop = () => setRun(0);

  /** Stop and start again with the same address and credentials. */
  const restart = () => start(urlRef.current, credentialsRef.current);

  useEffect(() => {
    if (!run) return;
    const { machineId, machineKey } = credentialsRef.current;
    const url = urlRef.current;
    let heldId: string | null = null;
    const handoff = startHandoff({
      url,
      hostId: machineId,
      machineKey,
      host: sessionHostOf(bridge()),
      // Between sessions the machine key holds the room with no stream: it
      // hears claims and answers latency probes, and takes no renter itself.
      openMachineSocket: ({ onClaim, onDenied, onConnection }) =>
        startHostSession({
          url,
          hostId: machineId,
          machineKey,
          onPeerHere: () => {},
          onPeerConnection: () => {},
          onSessionClaimed: onClaim,
          onDenied,
          onConnection,
          onRtt: (ms) => eventsRef.current.onRtt?.(ms),
        }),
      acceptClaim: (next) => eventsRef.current.acceptClaim?.(next) ?? true,
      onClaimRefused: (next) => eventsRef.current.onClaimRefused?.(next),
      onSession: (next) => {
        setSession(next);
        if (next && next.claim.sessionId !== heldId) {
          heldId = next.claim.sessionId;
          setClaim({ ...next.claim, at: Date.now() });
        } else if (!next && heldId !== null) {
          heldId = null;
          setClaim(null);
          eventsRef.current.onClaimOver?.();
        }
      },
      onConnection: (state) => {
        setConnection(state);
        if (state === "registered") {
          setLastContact(Date.now());
          setOfflineSince(null);
        } else if (state === "offline") {
          setOfflineSince((since) => since ?? Date.now());
        }
      },
      onDenied: () => {
        setError("The server refused this machine id and key.");
        setRun(0);
      },
    });
    return () => {
      void handoff.stop();
      setSession(null);
      setClaim(null);
      setConnection(null);
      setOfflineSince(null);
    };
  }, [run]);

  const step: HandoffStep | null = session?.step ?? null;
  return {
    live,
    /** Which run of sharing this is: a new number each time sharing starts, 0 while it is off. */
    run,
    claim,
    step,
    graceUntil: session?.graceUntil ?? null,
    peerHere: session?.playerHere ?? false,
    connection,
    lastContact,
    offlineSince,
    error,
    start,
    stop,
    restart,
  };
}
