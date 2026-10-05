import { useEffect, useRef, useState } from "react";
import { DEFAULT_CAPTURE, startHostSession, type HostConnection, type SessionClaim } from "@swiff/rtc";
import { refusedAddress, toSocketUrl } from "./settings";

export type Credentials = { machineId: string; machineKey: string };

/** A claim, and when this PC heard of it: the booked minutes run from there. */
export type HeldClaim = SessionClaim & { at: number };

export type ShareEvents = {
  /** A claimed session is over, or could not be started. */
  onClaimOver?: () => void;
  /** Whether to take a claim. One turned down is ended at once and never served. */
  acceptClaim?: (claim: SessionClaim) => boolean;
  onClaimRefused?: (claim: SessionClaim) => void;
  /** A round trip to the server, timed on the signaling socket. */
  onRtt?: (ms: number) => void;
};

/** Capture the screen, then hold the signaling session open while it runs. */
export function useScreenShare(events: ShareEvents = {}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [peerHere, setPeerHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<HeldClaim | null>(null);
  const [connection, setConnection] = useState<HostConnection | null>(null);
  /** When Swiff last confirmed the room, and since when it has not been reachable. */
  const [lastContact, setLastContact] = useState<number | null>(null);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const urlRef = useRef("");
  const credentialsRef = useRef<Credentials>({ machineId: "", machineKey: "" });
  const eventsRef = useRef(events);
  eventsRef.current = events;
  // Each start, and each stop, begins a new attempt: a capture that resolves
  // after a later one began is let go instead of shared.
  const attempt = useRef(0);

  /** Resolves true once the screen is being captured. */
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
    const mine = ++attempt.current;
    let captured: MediaStream | null = null;
    try {
      // Electron's main process answers this with the primary screen, so no
      // picker appears. The size hints are ignored, as they are in Chrome.
      //
      // Audio is asked for here and answered as Windows loopback in main.cjs.
      // A machine that cannot produce it still shares its screen: a silent
      // session beats no session.
      captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const [track] = captured.getVideoTracks();
      await track.applyConstraints({
        width: DEFAULT_CAPTURE.width,
        frameRate: DEFAULT_CAPTURE.frameRate,
      });
      if (mine !== attempt.current) {
        captured.getTracks().forEach((t) => t.stop());
        return false;
      }
      track.contentHint = "motion";
      track.addEventListener("ended", () => setStream(null));
      setStream(captured);
      return true;
    } catch (cause) {
      // A capture that could not be set up is never left running.
      captured?.getTracks().forEach((t) => t.stop());
      if (mine === attempt.current)
        setError(cause instanceof Error ? cause.message : "could not capture the screen");
      return false;
    }
  };

  const stop = () => {
    attempt.current++;
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  };

  /** Stop and start again with the same address and credentials. */
  const restart = async () => {
    stop();
    return start(urlRef.current, credentialsRef.current);
  };

  useEffect(() => {
    if (!stream) return;
    const session = startHostSession({
      url: urlRef.current,
      hostId: credentialsRef.current.machineId,
      machineKey: credentialsRef.current.machineKey,
      stream,
      onPeerHere: setPeerHere,
      onPeerConnection: setPc,
      onConnection: (state) => {
        setConnection(state);
        if (state === "registered") {
          setLastContact(Date.now());
          setOfflineSince(null);
        } else if (state === "offline") {
          setOfflineSince((since) => since ?? Date.now());
        }
      },
      // Stands in for the PC service: a claimed session is started here and
      // served with its session key, then the app waits for the next claim.
      serveClaims: true,
      onRtt: (ms) => eventsRef.current.onRtt?.(ms),
      acceptClaim: (next) => eventsRef.current.acceptClaim?.(next) ?? true,
      onClaimRefused: (next) => eventsRef.current.onClaimRefused?.(next),
      onSessionClaimed: (next) => setClaim({ ...next, at: Date.now() }),
      onClaimOver: () => {
        setClaim(null);
        setPeerHere(false);
        eventsRef.current.onClaimOver?.();
      },
      onDenied: () => {
        setError("The server refused this machine id and key.");
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      },
    });
    return () => {
      session.stop();
      setClaim(null);
      setPeerHere(false);
      setConnection(null);
      setOfflineSince(null);
    };
  }, [stream]);

  return { stream, pc, peerHere, claim, connection, lastContact, offlineSince, error, start, stop, restart };
}
