// Unit tests for the inbound ICE candidate queue.
//
// This exists because of one live failure: candidates arriving while
// `setRemoteDescription` was still in flight were passed straight to
// `addIceCandidate`, which rejected, and the rejection was swallowed. Every
// candidate the host had gathered was lost, no candidate pair was ever formed,
// and both peers sat at `failed · unknown`. It reproduced only when the await
// happened to be slow, so the ordering is pinned here rather than left to
// timing on whichever machine runs the suite.

import { describe, expect, it, vi } from "vitest";
import { createIceInbox } from "./iceInbox";

const CANDIDATE = (n: number): RTCIceCandidateInit => ({ candidate: `candidate:${n}`, sdpMid: "0" });

/**
 * A peer connection whose `setRemoteDescription` stays pending until released,
 * so a test can hold the exact window the bug lived in wide open.
 */
function deferredPc() {
  const added: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let remote: RTCSessionDescriptionInit | null = null;

  const pc = {
    get remoteDescription() {
      return remote;
    },
    setRemoteDescription: vi.fn(async (sdp: RTCSessionDescriptionInit) => {
      await gate;
      remote = sdp;
    }),
    addIceCandidate: vi.fn(async (c: RTCIceCandidateInit) => {
      // The real browser check: this is what threw before the queue existed.
      if (!remote) throw new Error("The remote description was null");
      added.push(c.candidate!);
    }),
  };

  return { pc: pc as unknown as RTCPeerConnection, raw: pc, added, release };
}

describe("createIceInbox", () => {
  it("holds candidates that arrive before the remote description, then delivers them in order", async () => {
    const { pc, added, release } = deferredPc();
    const inbox = createIceInbox(pc);

    const applying = inbox.setRemote({ type: "offer", sdp: "x" });
    // Mid-await: exactly when the host's candidates land over loopback.
    inbox.add(CANDIDATE(1));
    inbox.add(CANDIDATE(2));
    expect(added).toEqual([]);

    release();
    await applying;

    expect(added).toEqual(["candidate:1", "candidate:2"]);
  });

  it("delivers candidates straight through once the remote description is set", async () => {
    const { pc, added, release } = deferredPc();
    const inbox = createIceInbox(pc);

    release();
    await inbox.setRemote({ type: "offer", sdp: "x" });
    inbox.add(CANDIDATE(3));
    await vi.waitFor(() => expect(added).toEqual(["candidate:3"]));
  });

  it("never calls addIceCandidate while the remote description is still null", async () => {
    const { pc, raw, release } = deferredPc();
    const inbox = createIceInbox(pc);

    const applying = inbox.setRemote({ type: "offer", sdp: "x" });
    inbox.add(CANDIDATE(1));
    expect(raw.addIceCandidate).not.toHaveBeenCalled();

    release();
    await applying;

    expect(raw.addIceCandidate).toHaveBeenCalledTimes(1);
  });

  it("reports a candidate it could not use instead of swallowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pc, release } = deferredPc();
    const inbox = createIceInbox(pc);
    release();
    await inbox.setRemote({ type: "offer", sdp: "x" });

    vi.spyOn(pc, "addIceCandidate").mockRejectedValueOnce(new Error("malformed"));
    inbox.add(CANDIDATE(9));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("surfaces a failing setRemoteDescription rather than hiding it behind the queue", async () => {
    const pc = {
      setRemoteDescription: vi.fn().mockRejectedValue(new Error("bad sdp")),
      addIceCandidate: vi.fn(),
    } as unknown as RTCPeerConnection;

    await expect(createIceInbox(pc).setRemote({ type: "offer", sdp: "x" })).rejects.toThrow(
      "bad sdp",
    );
  });

  it("holds a candidate that arrives between two remote descriptions", async () => {
    // Renegotiation: the host tears down and re-offers. A candidate arriving in
    // that gap must not be thrown at a connection that cannot take it yet.
    const { pc, added, release } = deferredPc();
    const inbox = createIceInbox(pc);
    release();
    await inbox.setRemote({ type: "offer", sdp: "first" });

    inbox.add(CANDIDATE(1));
    await vi.waitFor(() => expect(added).toEqual(["candidate:1"]));
  });
});
