// Test doubles for connections that carry media both ways: tracks, senders,
// transceivers, and a peer connection that records what it was asked to make.

let ids = 0;

export class FakeTrack {
  readonly id = `track-${++ids}`;
  enabled = true;
  stopped = false;
  constructor(readonly kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
  }
}

export class FakeSender {
  track: FakeTrack | null = null;
  async replaceTrack(track: FakeTrack | null) {
    this.track = track;
  }
}

export class FakeTransceiver {
  mid: string | null = null;
  direction: RTCRtpTransceiverDirection;
  readonly sender = new FakeSender();
  readonly receiver: { track: FakeTrack };
  constructor(
    readonly kind: "audio" | "video",
    init: { direction?: RTCRtpTransceiverDirection; sendEncodings?: RTCRtpEncodingParameters[] } = {},
  ) {
    this.direction = init.direction ?? "sendrecv";
    this.receiver = { track: new FakeTrack(kind) };
    this.sendEncodings = init.sendEncodings ?? [];
  }
  sendEncodings: RTCRtpEncodingParameters[];
}

/** What an offer from the player's hub carries, in order: the picture, the game, the voice line, three voice slots. */
export const HUB_OFFER_KINDS: ("audio" | "video")[] = ["video", "audio", "audio", "audio", "audio", "audio"];

export class FakeMediaPeer extends EventTarget {
  static instances: FakeMediaPeer[] = [];
  /** The m-lines a remote offer brings, in order, for a connection that has made none itself. */
  static offerKinds: ("audio" | "video")[] = HUB_OFFER_KINDS;

  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  transceivers: FakeTransceiver[] = [];
  dataChannels: string[] = [];
  candidates: RTCIceCandidateInit[] = [];
  closed = false;
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ondatachannel: ((event: { channel: { label: string; close(): void } }) => void) | null = null;
  ontrack: ((event: { track: FakeTrack; transceiver: FakeTransceiver; streams: unknown[] }) => void) | null =
    null;

  constructor(readonly config: RTCConfiguration) {
    super();
    FakeMediaPeer.instances.push(this);
  }

  addTransceiver(
    trackOrKind: FakeTrack | "audio" | "video",
    init?: { direction?: RTCRtpTransceiverDirection; sendEncodings?: RTCRtpEncodingParameters[] },
  ) {
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
    const transceiver = new FakeTransceiver(kind, init);
    if (typeof trackOrKind !== "string") transceiver.sender.track = trackOrKind;
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() {
    return this.transceivers;
  }
  createDataChannel(label: string) {
    this.dataChannels.push(label);
    return { label, close() {} };
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new Error("closed");
    this.transceivers.forEach((t, i) => (t.mid ??= String(i)));
    return { type: "offer", sdp: `v=0 offer ${this.transceivers.length}` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.closed) throw new Error("closed");
    return { type: "answer", sdp: "v=0 answer" };
  }
  async setLocalDescription(sdp: RTCSessionDescriptionInit) {
    this.localDescription = sdp;
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit) {
    this.remoteDescription = sdp;
    if (sdp.type === "offer" && !this.transceivers.length) {
      FakeMediaPeer.offerKinds.forEach((kind, i) => {
        const t = this.addTransceiver(kind, { direction: "recvonly" });
        t.mid = String(i);
      });
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  async getStats() {
    return { forEach: () => {} };
  }
  close() {
    this.closed = true;
  }

  // --- test helpers ---
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  /** A track arrives on transceiver `index`. */
  arrive(index: number) {
    const transceiver = this.transceivers[index]!;
    this.ontrack?.({ track: transceiver.receiver.track, transceiver, streams: [] });
    return transceiver.receiver.track;
  }
  /** What each transceiver sends now, by index: a track id, or null. */
  sending() {
    return this.transceivers.map((t) => t.sender.track?.id ?? null);
  }
}

/** Enough of MediaStream for code that only wraps tracks in one. */
export class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
