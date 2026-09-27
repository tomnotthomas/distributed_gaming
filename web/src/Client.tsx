// The renter. Joins the room, answers the host's offer, plays the stream.
//
//   [ Connect ] ──► join ──► offer ──► createAnswer ──► send ──► ontrack ──► <video>

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPeerConnection,
  connectSignaling,
  DEFAULT_ICE_SERVERS,
  type SignalMessage,
} from "@swiff/rtc";
import { Button, Notice, PageShell, Stage, StatusLine, Tag } from "@swiff/ui";
import { HOST_ID, SIGNALING_URL } from "./config";

export function Client() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
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
      setPc(connection);

      connection.onicecandidate = (event) => {
        if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
      };

      connection.ontrack = (event) => {
        if (videoRef.current) videoRef.current.srcObject = event.streams[0];
        setPlaying(true);
        // The largest single latency win available: do not buffer for smoothness.
        const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
      };

      await connection.setRemoteDescription(sdp);
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
            if (msg.candidate) void pcRef.current?.addIceCandidate(msg.candidate).catch(() => {});
            break;
          case "peer-left":
            setNote("gaming PC disconnected");
            setPlaying(false);
            pcRef.current?.close();
            pcRef.current = null;
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
      meta={<Tag label="Room" value={HOST_ID} />}
    >
      <div className="row">
        {!connecting ? (
          <Button large onClick={() => setConnecting(true)}>
            Connect
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setConnecting(false);
              setPlaying(false);
            }}
          >
            Disconnect
          </Button>
        )}
      </div>

      {error ? <Notice>{error}</Notice> : null}

      <StatusLine pc={pc} note={note} />

      <Stage ref={videoRef} empty={!playing} placeholder="no stream yet" />
    </PageShell>
  );
}
