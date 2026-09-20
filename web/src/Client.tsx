// The renter. Joins the room, answers the host's offer, plays the stream.
//
//   [ Connect ] ──► join ──► offer ──► createAnswer ──► send ──► ontrack ──► <video>

import { useCallback, useEffect, useRef, useState } from "react";
import { HOST_ID } from "./config";
import { createPeerConnection } from "./peer";
import { connectSignaling, type SignalMessage } from "./signaling";
import { StatusLine } from "./StatusLine";

export function Client() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const answerOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit, send: (m: SignalMessage) => void) => {
      pcRef.current?.close();
      const connection = createPeerConnection();
      pcRef.current = connection;
      setPc(connection);

      connection.onicecandidate = (event) => {
        if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
      };

      connection.ontrack = (event) => {
        if (videoRef.current) videoRef.current.srcObject = event.streams[0];
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
      onOpen: (send) => send({ type: "join", hostId: HOST_ID }),
      onMessage: (msg, send) => {
        switch (msg.type) {
          case "joined":
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
    <main>
      <h1>Swiff</h1>
      <p className="muted">Room: {HOST_ID}</p>

      {!connecting ? (
        <button onClick={() => setConnecting(true)}>Connect</button>
      ) : (
        <button onClick={() => setConnecting(false)}>Disconnect</button>
      )}

      {error ? <p className="error">{error}</p> : null}

      <StatusLine pc={pc} note={note} />

      <video ref={videoRef} autoPlay playsInline className="stream" />
    </main>
  );
}
