// The browser host page. Kept as a dev convenience: it needs a human to click
// Chrome's screen picker, which is exactly why the real gaming PC runs the
// Electron app in desktop/ instead.
//
// PHASE 1 CAPTURES THE OWNER'S OWN DESKTOP. Phase 2 moves this inside a
// separate Windows account (docs/diagrams/host-isolation.png) so a renter
// never sees the owner's files. Until then, run only on a machine with
// nothing private on it.
//
// A browser cannot press keys on its own machine, so the renter's input is not
// replayed here. It is received and shown instead — what the renter is holding
// right now — which is the part the Windows host shares with this page.

import { useEffect, useRef, useState } from "react";
import {
  createInputReceiver,
  DEFAULT_CAPTURE,
  startHostSession,
  type HeldInput,
  type InputReceiver,
  type SessionClaim,
} from "@swiff/rtc";
import { Button, Field, Input, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { HOST_ID, SIGNALING_URL } from "./config";
import posthog, { isPostHogEnabled } from "./posthog";

/** Render the browser host, sharing a captured screen and displaying held renter input. */
export function Host() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Typed in each time and never stored: this page is a dev tool, and a
  // browser's storage is not a place for a machine's credential.
  const [machineKey, setMachineKey] = useState("");
  const [peerHere, setPeerHere] = useState(false);
  // How long the server holds the session of a renter who dropped (seconds),
  // until they come back or the next one joins; null when nobody dropped.
  const [graceS, setGraceS] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldInput | null>(null);
  const [claim, setClaim] = useState<SessionClaim | null>(null);
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
    let receiver: InputReceiver | null = null;
    const closeInput = () => {
      receiver?.close();
      receiver = null;
      setHeld(null);
    };

    const session = startHostSession({
      url: SIGNALING_URL,
      hostId: HOST_ID,
      machineKey: machineKey.trim(),
      stream,
      onPeerHere: (here) => {
        setPeerHere(here);
        if (here) setGraceS(null);
      },
      // A renter who dropped mid-session may come back: the session is held,
      // and the shared screen (the game) keeps running meanwhile.
      onPeerLeft: setGraceS,
      // Stands in for the PC service: a claimed session is started here and
      // served with its session key, then the page waits for the next claim.
      serveClaims: true,
      onSessionClaimed: setClaim,
      onClaimOver: () => {
        setClaim(null);
        setGraceS(null);
      },
      // The screen being shared stands in for the game, so it is running at once.
      launchGame: () => {},
      onPeerConnection: (next) => {
        if (!next) closeInput();
        setPc(next);
      },
      onInputChannels: ({ keys, motion }) => {
        closeInput();
        const show = () => setHeld(current.held());
        const current = createInputReceiver({
          sink: { move() {}, moveBy() {}, wheel() {}, key: show, button: show, gamepad: show },
        });
        current.attach(keys);
        current.attach(motion);
        receiver = current;
        setHeld(current.held());
      },
      onDenied: () => {
        setError("The server refused this machine key.");
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      },
    });
    return () => {
      session.stop();
      closeInput();
      setClaim(null);
    };
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
          <p className="muted">
            {peerHere
              ? "A renter is connected."
              : graceS !== null
                ? `The renter dropped. Their session is held for ${graceS} s while they come back.`
                : "Waiting for a renter…"}
          </p>
        )}
      </div>

      {error ? <Notice>{error}</Notice> : null}

      {claim ? <p className="muted">Claimed by a renter for {claim.minutes} minutes.</p> : null}

      {held ? <p className="muted">Renter is holding: {describeHeld(held)}</p> : null}

      <StatusLine pc={pc} note={stream ? undefined : "not capturing"} />

      <Stage ref={previewRef} muted small empty={!stream} placeholder="not capturing" />
    </PageShell>
  );
}

const BUTTON_NAMES = ["left mouse", "middle mouse", "right mouse", "back mouse", "forward mouse"];

/** Format held keys, mouse buttons and controllers, or "nothing" when all are released. */
function describeHeld({ keys, buttons, gamepads }: HeldInput): string {
  const all = [
    ...keys,
    ...buttons.map((b) => BUTTON_NAMES[b]),
    ...gamepads.map((i) => `controller ${i + 1}`),
  ];
  return all.length ? all.join(", ") : "nothing";
}
