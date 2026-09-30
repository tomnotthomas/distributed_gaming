// The renter. Joins the room, answers the host's offer, plays the stream, and
// sends mouse, keyboard and controller input back over the host's data channels.
//
//   [ Connect ] ──► join(ticket) ──► offer ──► createAnswer ──► send ──► ontrack ──► <video>
//                                                                 └──► ondatachannel ×2 ──► input

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createIceInbox,
  createPeerConnection,
  connectSignaling,
  DEFAULT_ICE_SERVERS,
  inputLane,
  INPUT_PROTOCOL,
  startInputCapture,
  type IceInbox,
  type InputCapture,
  type InputLane,
  type SignalMessage,
} from "@swiff/rtc";
import { Button, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { SIGNALING_URL, ticketFromUrl } from "./config";
import posthog, { isPostHogEnabled } from "./posthog";

const DENIED: Record<string, string> = {
  "bad-ticket": "This link is invalid or has expired. Ask for a new one.",
  "room-taken": "Someone else is already playing on this machine.",
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

  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Holds the host's candidates until its offer has been applied.
  const inboxRef = useRef<IceInbox | null>(null);
  // TURN from the server's `joined`, which always precedes the host's offer.
  const serverIceRef = useRef<RTCIceServer[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<InputCapture | null>(null);

  // Releases every key and button still held before input stops, so the PC is
  // never left with one pressed. Called before the connection goes away.
  const stopInput = useCallback(() => {
    inputRef.current?.stop();
    inputRef.current = null;
  }, []);

  const answerOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit, send: (m: SignalMessage) => void) => {
      stopInput();
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

      // The host opens two input channels, keys and motion; input starts once
      // both are open, and stops for good when either closes.
      const lanes: Partial<Record<InputLane, RTCDataChannel>> = {};
      let capture: InputCapture | null = null;
      const startInput = () => {
        const { keys, motion } = lanes;
        const target = videoRef.current;
        if (capture || !target || keys?.readyState !== "open" || motion?.readyState !== "open") return;
        stopInput();
        capture = startInputCapture({ target, channels: { keys, motion } });
        inputRef.current = capture;
      };

      connection.ondatachannel = ({ channel }) => {
        const lane = inputLane(channel.label);
        if (!lane) return;
        if (channel.protocol !== INPUT_PROTOCOL) {
          console.warn(
            `[swiff] the gaming PC speaks ${channel.protocol || "no"} input protocol; input is off`,
          );
          return;
        }
        lanes[lane] = channel;
        if (channel.readyState === "open") startInput();
        else channel.addEventListener("open", startInput, { once: true });
        // Only this connection's own capture: a later one may own the ref by now.
        channel.addEventListener("close", () => {
          if (capture && inputRef.current === capture) stopInput();
        });
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
    [stopInput],
  );

  useEffect(() => {
    if (!connecting) return;

    const signaling = connectSignaling({
      url: SIGNALING_URL,
      onOpen: (send) => send({ type: "join", ticket }),
      onMessage: (msg, send) => {
        switch (msg.type) {
          case "denied":
            setError(DENIED[msg.reason] ?? "The server refused this connection.");
            setConnecting(false);
            break;
          case "joined":
            setRoom(msg.hostId);
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
            stopInput();
            pcRef.current?.close();
            pcRef.current = null;
            inboxRef.current = null;
            setPc(null);
            break;
        }
      },
    });

    return () => {
      // Let go of everything first, while the channel can still carry it.
      stopInput();
      signaling.close();
    };
  }, [connecting, answerOffer, stopInput, ticket]);

  return (
    <PageShell
      title="Swiff"
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
