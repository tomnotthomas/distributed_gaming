// The renter's bare WebRTC test page. `startRenterSession` joins the room,
// answers the host's offer, plays the stream and sends input back; this page
// only turns its events into the status line and buttons.
//
//   [ Connect ] ──► startRenterSession({ ticket, video }) ──► events ──► status, notes, <video>

import { useEffect, useRef, useState } from "react";
import { startRenterSession } from "@swiff/rtc";
import { Button, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { SIGNALING_URL, ticketFromUrl } from "./config";
import posthog, { isPostHogEnabled } from "./posthog";

const DENIED: Record<string, string> = {
  "bad-ticket": "This link is invalid or has expired. Ask for a new one.",
  "room-taken": "Someone else is already playing on this machine.",
  replaced: "This session was opened somewhere else.",
};

/** Render the renter page, joining with a ticket to play the stream and send input. */
export function Client() {
  const [ticket] = useState(ticketFromUrl);
  const [room, setRoom] = useState<string | null>(null);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // Only true when the browser refused to start audible playback. Clicking
  // Connect is a user gesture and normally earns the right to sound, but a
  // browser that disagrees must still show the picture.
  const [mutedByBrowser, setMutedByBrowser] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!connecting || !videoRef.current) return;

    const session = startRenterSession({ url: SIGNALING_URL, ticket, video: videoRef.current });
    session.on((event) => {
      switch (event.type) {
        case "denied":
          setError(DENIED[event.reason] ?? "The server refused this connection.");
          setConnecting(false);
          break;
        case "joined":
          setRoom(event.hostId);
          setNote(event.hostOnline ? undefined : "gaming PC is offline — waiting");
          break;
        case "peer-connection":
          setPc(event.pc);
          if (event.pc) setNote(undefined);
          break;
        case "track":
          setPlaying(true);
          if (isPostHogEnabled) posthog.capture("client_stream_started");
          break;
        case "autoplay-muted":
          setMutedByBrowser(true);
          break;
        case "error":
          setError(event.message);
          break;
        case "peer-left":
          setNote("gaming PC disconnected");
          setPlaying(false);
          break;
      }
    });

    // Releases held input before it hangs up, while the channels can carry it.
    return () => session.end();
  }, [connecting, ticket]);

  return (
    <PageShell
      title="Lanterel"
      subtitle="Rent a gaming PC. Play it in this tab."
      meta={room ? <Tag label="Room">{room}</Tag> : undefined}
    >
      <div className="row">
        {!ticket ? (
          <p className="muted">You need a join link to connect.</p>
        ) : !connecting ? (
          <Button
            size="lg"
            onClick={() => {
              setError(null);
              if (isPostHogEnabled) posthog.capture("client_connection_requested");
              setConnecting(true);
            }}
          >
            Connect
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              if (isPostHogEnabled) posthog.capture("client_connection_ended");
              setConnecting(false);
              setPlaying(false);
            }}
          >
            Disconnect
          </Button>
        )}

        {playing && mutedByBrowser ? (
          <Button
            variant="secondary"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = false;
              setMutedByBrowser(false);
              void video.play().catch(() => {});
            }}
          >
            Turn sound on
          </Button>
        ) : null}
      </div>

      {error ? <Notice>{error}</Notice> : null}

      <StatusLine pc={pc} note={note} />

      <Stage ref={videoRef} empty={!playing} placeholder="no stream yet" />
    </PageShell>
  );
}
