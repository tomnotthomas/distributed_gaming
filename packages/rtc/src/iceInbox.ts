// Inbound ICE candidates, held until the peer connection can accept them.
//
// Both peers hit the same race. The host starts gathering at
// `setLocalDescription`, which runs *before* it sends the offer, so its
// candidates are already in flight when the offer lands. The renter answers
// asynchronously, and `addIceCandidate` throws `InvalidStateError` on a
// connection whose remote description is still null. Over loopback the
// candidates arrive a millisecond or two behind the offer — comfortably inside
// the await — and a dropped candidate is never re-sent.
//
// Lose them all and neither side has anywhere to send a connectivity check, so
// no candidate pair is ever formed and the connection sits at
// `failed · unknown`. It is timing-dependent, so it passes far more often than
// it fails, which is exactly what makes it worth pinning down in code.
//
// Both halves live here on purpose: a caller cannot set the remote description
// without also releasing what arrived while it was waiting.

export type IceInbox = {
  /** Deliver a candidate, or hold it until the remote description lands. */
  add(candidate: RTCIceCandidateInit): void;
  /** Apply the remote description, then release everything held behind it. */
  setRemote(sdp: RTCSessionDescriptionInit): Promise<void>;
};

export function createIceInbox(pc: RTCPeerConnection): IceInbox {
  const held: RTCIceCandidateInit[] = [];
  let accepting = false;

  // A candidate the far side gathered but this one cannot use is a real signal.
  // Swallowing it silently is how the race above stayed invisible.
  const deliver = (candidate: RTCIceCandidateInit) =>
    pc.addIceCandidate(candidate).catch((cause) => {
      console.warn("[swiff] dropped an ICE candidate", cause);
    });

  return {
    add(candidate) {
      if (accepting) void deliver(candidate);
      else held.push(candidate);
    },

    async setRemote(sdp) {
      await pc.setRemoteDescription(sdp);
      // Only now, so anything that arrived during the await is still queued
      // rather than racing past this line into a rejection.
      accepting = true;
      await Promise.all(held.splice(0).map(deliver));
    },
  };
}
