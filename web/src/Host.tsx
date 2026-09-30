// The browser host page. Kept as a dev convenience: it needs a human to click
// Chrome's screen picker, which is exactly why the real gaming PC runs the
// Electron app in desktop/ instead.
//
// PHASE 1 CAPTURES THE OWNER'S OWN DESKTOP. Phase 2 moves this inside a
// separate Windows account (docs/diagrams/host-isolation.png) so a renter
// never sees the owner's files. Until then, run only on a machine with
// nothing private on it.

import { useEffect, useRef, useState } from "react";
import { DEFAULT_CAPTURE, startHostSession } from "@swiff/rtc";
import { Button, Field, Input, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { HOST_ID, SIGNALING_URL } from "./config";
import posthog, { isPostHogEnabled } from "./posthog";

export function Host() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Typed in each time and never stored: this page is a dev tool, and a
  // browser's storage is not a place for a machine's credential.
  const [machineKey, setMachineKey] = useState("");
  const [peerHere, setPeerHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  const startSharing = async () => {
    setError(null);
    if (!machineKey.trim()) return setError("Paste this machine's key first.");
    try {
      // Chrome IGNORES width/height/frameRate passed in here, so the returned
      // track is whatever the monitor is. Downscale afterwards.
      // Audio is offered, not required: Chrome only includes it if the owner
      // ticks "Share system audio" in the picker, and the session is fine
      // without it.
      const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const [track] = captured.getVideoTracks();
      await track.applyConstraints({
        width: DEFAULT_CAPTURE.width,
        frameRate: DEFAULT_CAPTURE.frameRate,
      });
      track.contentHint = "motion";
      // The owner can stop sharing from Chrome's own bar; treat that as a stop.
      track.addEventListener("ended", () => {
        if (isPostHogEnabled) posthog.capture("host_screen_share_ended");
        setStream(null);
      });

      if (previewRef.current) previewRef.current.srcObject = captured;
      setStream(captured);
      if (isPostHogEnabled) posthog.capture("host_screen_share_started");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not start capture");
    }
  };

  useEffect(() => {
    if (!stream) return;
    const session = startHostSession({
      url: SIGNALING_URL,
      hostId: HOST_ID,
      machineKey: machineKey.trim(),
      stream,
      onPeerHere: setPeerHere,
      onPeerConnection: setPc,
      onDenied: () => {
        setError("The server refused this machine key.");
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      },
    });
    return () => session.stop();
    // The key is read when sharing starts; editing it mid-session changes nothing.
  }, [stream]);

  return (
    <PageShell
      title="Gaming PC"
      subtitle="Share this screen with whoever joins the room."
      meta={<Tag label="Room">{HOST_ID}</Tag>}
    >
      <Field label="Machine key" hint="From npm run machine-key. Not stored.">
        <Input
          type="password"
          autoComplete="off"
          value={machineKey}
          disabled={!!stream}
          onChange={(e) => setMachineKey(e.target.value)}
        />
      </Field>

      <div className="row">
        {!stream ? (
          <Button size="lg" onClick={() => void startSharing()}>
            Start sharing
          </Button>
        ) : (
          <p className="muted">{peerHere ? "A renter is connected." : "Waiting for a renter…"}</p>
        )}
      </div>

      {error ? <Notice>{error}</Notice> : null}

      <StatusLine pc={pc} note={stream ? undefined : "not capturing"} />

      <Stage ref={previewRef} muted small empty={!stream} placeholder="not capturing" />
    </PageShell>
  );
}
