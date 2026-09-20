// The gaming PC. Captures the screen and offers it to whoever joins the room.
//
//   [ Start sharing ] ──► getDisplayMedia ──► constrain track ──► register
//                                                                    │
//                                                             peer-joined
//                                                                    │
//                                        addTrack ──► tune encoder ──┤
//                                                                    │
//                                              createOffer ──► send ─┘
//                                                                    │
//                                               answer ──► connected ┘
//
// The host creates the offer because the host owns the media track.
//
// PHASE 1 CAPTURES THE OWNER'S OWN DESKTOP. Phase 2 moves this inside a
// separate Windows account (docs/diagrams/host-isolation.png) so a renter never
// sees the owner's files. Until then, run only on a machine with nothing
// private on it.

import { useCallback, useEffect, useRef, useState } from "react";
import { CAPTURE, HOST_ID } from "./config";
import { createPeerConnection } from "./peer";
import { connectSignaling, type Signaling, type SignalMessage } from "./signaling";
import { StatusLine } from "./StatusLine";

export function Host() {
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [peerHere, setPeerHere] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalingRef = useRef<Signaling | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  /** Build the peer connection and push an offer. Runs once a renter is here. */
  const offerTo = useCallback(async (send: (m: SignalMessage) => void) => {
    const stream = streamRef.current;
    if (!stream) return;

    pcRef.current?.close();
    const connection = createPeerConnection();
    pcRef.current = connection;
    setPc(connection);

    connection.onicecandidate = (event) => {
      if (event.candidate) send({ type: "ice", candidate: event.candidate.toJSON() });
    };

    const [track] = stream.getVideoTracks();
    const sender = connection.addTrack(track, stream);

    // Each of these fails silently if omitted, and each costs real quality.
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.degradationPreference = "maintain-resolution"; // else Chrome drops to 320x180 under load
    params.encodings[0].maxBitrate = CAPTURE.maxBitrate; // else estimation saturates the link
    await sender.setParameters(params);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    send({ type: "offer", sdp: offer });
  }, []);

  const startSharing = useCallback(async () => {
    setError(null);
    try {
      // Chrome IGNORES width/height/frameRate passed in here, so the returned
      // track is whatever the monitor is — a 4K panel hands back a raw 4K
      // track. Downscale afterwards.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      await track.applyConstraints({ width: CAPTURE.width, frameRate: CAPTURE.frameRate });
      track.contentHint = "motion";

      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setSharing(true);

      // The owner can stop sharing from Chrome's own bar; treat that as a stop.
      track.addEventListener("ended", () => {
        setSharing(false);
        pcRef.current?.close();
        pcRef.current = null;
        setPc(null);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not start capture");
    }
  }, []);

  useEffect(() => {
    if (!sharing) return;

    const signaling = connectSignaling({
      onOpen: (send) => send({ type: "register", hostId: HOST_ID }),
      onMessage: (msg, send) => {
        switch (msg.type) {
          case "peer-joined":
            setPeerHere(true);
            void offerTo(send);
            break;
          case "answer":
            if (msg.sdp) void pcRef.current?.setRemoteDescription(msg.sdp);
            break;
          case "ice":
            if (msg.candidate) void pcRef.current?.addIceCandidate(msg.candidate).catch(() => {});
            break;
          case "peer-left":
            setPeerHere(false);
            pcRef.current?.close();
            pcRef.current = null;
            setPc(null);
            break;
        }
      },
    });
    signalingRef.current = signaling;

    return () => {
      signaling.close();
      signalingRef.current = null;
    };
  }, [sharing, offerTo]);

  return (
    <main>
      <h1>Gaming PC</h1>
      <p className="muted">Room: {HOST_ID}</p>

      {!sharing ? (
        <button onClick={() => void startSharing()}>Start sharing</button>
      ) : (
        <p className="muted">{peerHere ? "A renter is connected." : "Waiting for a renter…"}</p>
      )}

      {error ? <p className="error">{error}</p> : null}

      <StatusLine pc={pc} note={sharing ? undefined : "not capturing"} />

      <video ref={previewRef} autoPlay muted playsInline className="preview" />
    </main>
  );
}
