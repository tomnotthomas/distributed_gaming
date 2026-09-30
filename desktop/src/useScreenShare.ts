import { useEffect, useRef, useState } from "react";
import { DEFAULT_CAPTURE, startHostSession } from "@swiff/rtc";
import { toSocketUrl } from "./settings";

export type Credentials = { machineId: string; machineKey: string };

/** Capture the screen, then hold the signaling session open while it runs. */
export function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [peerHere, setPeerHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef("");
  const credentialsRef = useRef<Credentials>({ machineId: "", machineKey: "" });

  const start = async (rawUrl: string, credentials: Credentials) => {
    setError(null);
    const url = toSocketUrl(rawUrl);
    if (!url) return setError("Paste the signaling server address first.");
    if (!credentials.machineId || !credentials.machineKey) {
      return setError("Fill in this machine's id and key first.");
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not capture the screen");
    }
  };

  const stop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
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
      onDenied: () => {
        setError("The server refused this machine id and key.");
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      },
    });
    return () => session.stop();
  }, [stream]);

  return { stream, pc, peerHere, error, start, stop };
}
