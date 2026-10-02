import { useEffect, useRef, useState } from "react";
import { DEFAULT_CAPTURE, startHostSession, type HostConnection, type SessionClaim } from "@swiff/rtc";
import { toSocketUrl } from "./settings";

export type Credentials = { machineId: string; machineKey: string };

/** A claim, and when this PC heard of it: the booked minutes run from there. */
export type HeldClaim = SessionClaim & { at: number };

export type ShareEvents = {
  /** A claimed session is over, or could not be started. */
  onClaimOver?: () => void;
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

  /** Resolves true once the screen is being captured. */
  const start = async (rawUrl: string, credentials: Credentials): Promise<boolean> => {
    setError(null);
    const url = toSocketUrl(rawUrl);
    if (!url) {
      setError("Paste the signaling server address first.");
      return false;
    }
    if (!credentials.machineId || !credentials.machineKey) {
      setError("Fill in this machine's id and key first.");
      return false;
    }
    urlRef.current = url;
    credentialsRef.current = credentials;
    try {
      // Electron's main process answers this with the primary screen, so no
      // picker appears. The size hints are ignored, as they are in Chrome.
      //
      // Audio is asked for here and answered as Windows loopback in main.cjs.
      // A machine that cannot produce it still shares its screen: a silent
      // session beats no session.
      const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const [track] = captured.getVideoTracks();
      await track.applyConstraints({
        width: DEFAULT_CAPTURE.width,
        frameRate: DEFAULT_CAPTURE.frameRate,
      });
      track.contentHint = "motion";
      track.addEventListener("ended", () => setStream(null));
      setStream(captured);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not capture the screen");
      return false;
    }
  };

  const stop = () => {
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
