// The renter. Joins the room, answers the host's offer, plays the stream.
//
//   [ Connect ] ──► join ──► offer ──► createAnswer ──► send ──► ontrack ──► <video>

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createIceInbox,
  createPeerConnection,
  connectSignaling,
  DEFAULT_ICE_SERVERS,
  type IceInbox,
  type SignalMessage,
} from "@swiff/rtc";
import { Button, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { HOST_ID, SIGNALING_URL } from "./config";
import posthog, { isPostHogEnabled } from "./posthog";

export function Client() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // Only true when the browser refused to start audible playback. Clicking
  // Connect is a user gesture and normally earns the right to sound, but a
  // browser that disagrees must still show the picture.
  const [mutedByBrowser, setMutedByBrowser] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Holds the host's candidates until its offer has been applied.
  const inboxRef = useRef<IceInbox | null>(null);
  // TURN from the server's `joined`, which always precedes the host's offer.
  const serverIceRef = useRef<RTCIceServer[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);

  const answerOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit, send: (m: SignalMessage) => void) => {
      pcRef.current?.close();
      const connection = createPeerConnection({
        iceServers: [...DEFAULT_ICE_SERVERS, ...serverIceRef.current],
      });
      pcRef.current = connection;
      inboxRef.current = createIceInbox(connection);
      setPc(connection);

      connection.onicecandidate = (event) => {
        if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
      };

      connection.ontrack = (event) => {
        const video = videoRef.current;
        if (video) {
          video.srcObject = event.streams[0];
          // Audio arrives as a second track on the same stream, so ontrack
          // fires twice; starting playback again is harmless and covers the
          // case where the audio track is the one that lands first.
          void video.play().catch(() => {
            video.muted = true;
            setMutedByBrowser(true);
            return video.play().catch(() => {});
          });
        }
        setPlaying(true);
        if (isPostHogEnabled) posthog.capture("client_stream_started");
        // The largest single latency win available: do not buffer for smoothness.
        const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
      };

      await inboxRef.current.setRemote(sdp);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      send({ type: "answer", sdp: answer });
    },
    [],
  );

  useEffect(() => {
    if (!connecting) return;

    const signaling = connectSignaling({
      url: SIGNALING_URL,
      onOpen: (send) => send({ type: "join", hostId: HOST_ID }),
      onMessage: (msg, send) => {
        switch (msg.type) {
          case "joined":
            serverIceRef.current = msg.iceServers ?? [];
            setNote(msg.hostOnline ? undefined : "gaming PC is offline — waiting");
            break;
          case "offer":
            if (msg.sdp) {
              setNote(undefined);
              void answerOffer(msg.sdp, send).catch((cause) =>
                setError(cause instanceof Error ? cause.message : "could not answer"),
              );
            }
            break;
          case "ice":
            if (msg.candidate) inboxRef.current?.add(msg.candidate);
            break;
          case "peer-left":
            setNote("gaming PC disconnected");
            setPlaying(false);
            pcRef.current?.close();
            pcRef.current = null;
            inboxRef.current = null;
            setPc(null);
            break;
        }
      },
    });

    return () => signaling.close();
  }, [connecting, answerOffer]);

  return (
    <PageShell
      title="Swiff"
      subtitle="Rent a gaming PC. Play it in this tab."
      meta={<Tag label="Room">{HOST_ID}</Tag>}
    >
      <div className="row">
        {!connecting ? (
          <Button
            size="lg"
            onClick={() => {
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
