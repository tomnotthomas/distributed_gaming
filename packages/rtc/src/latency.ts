// The renter's side of a latency probe: the real path to a few PCs, measured
// before anything is booked. One peer connection per PC with a single data
// channel and no media, opened over signaling and closed as soon as it has
// answered. It never joins a room, so it never takes a seat.
//
//   probe (token, offer) ──► probe-answer ──► channel open ──► 10 pings echoed ──► getStats
//
// The channel is unordered and never retransmits, so a late or lost ping is
// seen as one rather than hidden behind a resend. From the echoes: the median
// round trip, the jitter (95th percentile of the change from one round trip to
// the next), and from the candidate pair ICE chose whether the path goes
// through a TURN relay. All the probes run at once; the whole takes a second or
// two. Wire format: server/src/protocol.ts. The PC's side is probe.ts.

import { candidateTypeOf, createPeerConnection, DEFAULT_ICE_SERVERS, selectedCandidatePair } from "./peer";
import type { SignalMessage } from "./signaling";

/** A PC to probe, with the token the server handed out for it. */
export type ProbeTarget = { hostId: string; token: string };

/** What a probe measured: the median round trip and its jitter in ms, and whether it went through TURN. */
export type MeasuredLink = { rttMs: number; jitterMs: number; relayed: boolean };

/**
 * How one probe ended:
 *
 *   measured     the PC answered and echoed: `link` is the real path
 *   unreachable  the PC answered, but no channel opened or nothing came back in time
 *   unanswered   the server refused the probe (`reason`), or no answer came: nothing is known
 */
export type ProbeResult =
  | { hostId: string; status: "measured"; link: MeasuredLink }
  | { hostId: string; status: "unreachable" }
  | { hostId: string; status: "unanswered"; reason?: "bad-token" | "too-many" | "host-offline" };

/** Pings per probe. */
export const PROBE_PINGS = 10;
/** The pause between pings: ten of them go out in under a quarter of a second. */
const PING_GAP_MS = 25;
/** How long the offer waits for its candidates before it is sent with those it has. */
const GATHER_MS = 1_000;
/** How long after the last ping its echo may still come back. */
const ECHO_WAIT_MS = 500;
/** The longest one probe may take, from start to its last echo. */
export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeOptions = {
  /** ws:// or wss:// origin of the signaling server. */
  url: string;
  targets: ProbeTarget[];
  /** The TURN relay the server offers, added to the default STUN. */
  iceServers?: RTCIceServer[];
  /** For tests. */
  createPeer?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  openSocket?: (url: string) => WebSocket;
  now?: () => number;
  timeoutMs?: number;
};

/** The 95th percentile of `values`, nearest rank; 0 for none. */
function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The link from round trips in the order the pings were sent, lost ones left
 * out. Jitter is the 95th percentile of the change between consecutive ones.
 */
export function linkOf(rtts: number[], relayed: boolean): MeasuredLink {
  const changes = rtts.slice(1).map((rtt, i) => Math.abs(rtt - rtts[i]!));
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return { rttMs: round(median(rtts)), jitterMs: round(p95(changes)), relayed };
}

/** Whether ICE chose a path through TURN, on either side, by the selected candidate pair. */
async function viaRelay(pc: RTCPeerConnection): Promise<boolean> {
  try {
    const stats = await pc.getStats();
    const pair = selectedCandidatePair(stats);
    return (
      candidateTypeOf(stats, pair?.localCandidateId) === "relay" ||
      candidateTypeOf(stats, pair?.remoteCandidateId) === "relay"
    );
  } catch {
    return false;
  }
}

/** Resolve once `pc` has gathered its candidates, or after `ms`, whichever is first. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** One probe in flight. */
type Probe = {
  target: ProbeTarget;
  pc: RTCPeerConnection;
  /** Settle the probe; later calls do nothing. */
  finish: (result: ProbeResult) => void;
  /** The PC's answer arrived. */
  answered: (sdp: RTCSessionDescriptionInit) => void;
  /** The socket is gone: a probe still waiting for its answer will get none. */
  lost: () => void;
};

/**
 * Probe every target at once over one signaling socket. Resolves with one
 * result per target, in the order given, within PROBE_TIMEOUT_MS. Never rejects.
 */
export function probeLatency({
  url,
  targets,
  iceServers = [],
  createPeer = (servers) => createPeerConnection({ iceServers: servers }),
  openSocket = (to) => new WebSocket(to),
  now = () => performance.now(),
  timeoutMs = PROBE_TIMEOUT_MS,
}: ProbeOptions): Promise<ProbeResult[]> {
  if (!targets.length) return Promise.resolve([]);
  const servers = [...DEFAULT_ICE_SERVERS, ...iceServers];
  const probes = new Map<string, Probe>();
  let socket: WebSocket;
  try {
    socket = openSocket(url);
  } catch {
    return Promise.resolve(targets.map(({ hostId }) => ({ hostId, status: "unanswered" })));
  }
  /** Offers made before the socket opened, sent once it does. */
  const queued: SignalMessage[] = [];
  const send = (msg: SignalMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else queued.push(msg);
  };

  const results = targets.map((target, index) =>
    run(target, `p${index}`, servers, createPeer, send, now, timeoutMs, (probe) =>
      probes.set(`p${index}`, probe),
    ),
  );

  socket.onopen = () => queued.splice(0).forEach((msg) => socket.send(JSON.stringify(msg)));
  socket.onmessage = (event: MessageEvent) => {
    let msg: SignalMessage;
    try {
      msg = JSON.parse(String(event.data)) as SignalMessage;
    } catch {
      return;
    }
    const probe = "probeId" in msg ? probes.get(msg.probeId) : undefined;
    if (!probe) return;
    if (msg.type === "probe-answer") probe.answered(msg.sdp);
    if (msg.type === "probe-refused")
      probe.finish({ hostId: probe.target.hostId, status: "unanswered", reason: msg.reason });
  };
  // A socket that fails or closes early answers nothing more. A probe already
  // answered needs it no longer.
  socket.onclose = () => probes.forEach((probe) => probe.lost());

  return Promise.all(results).finally(() => socket.close());
}

/** Probe one target: resolves with its result by `timeoutMs`, its peer connection closed. */
function run(
  target: ProbeTarget,
  probeId: string,
  servers: RTCIceServer[],
  createPeer: (iceServers: RTCIceServer[]) => RTCPeerConnection,
  send: (msg: SignalMessage) => void,
  now: () => number,
  timeoutMs: number,
  register: (probe: Probe) => void,
): Promise<ProbeResult> {
  const { hostId } = target;
  return new Promise<ProbeResult>((resolve) => {
    const pc = createPeer(servers);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let answered = false;
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      pc.close();
      resolve(result);
    };
    // No answer in time: nothing is known. Answered but not through: unreachable.
    timers.push(
      setTimeout(
        () => finish(answered ? { hostId, status: "unreachable" } : { hostId, status: "unanswered" }),
        timeoutMs,
      ),
    );

    const channel = pc.createDataChannel("probe", { ordered: false, maxRetransmits: 0 });
    const sentAt = new Map<number, number>();
    const rtts = new Map<number, number>();

    /** Every ping is in, or the last has had its time: measure what came back. */
    const measure = async () => {
      if (settled) return;
      if (!rtts.size) return finish({ hostId, status: "unreachable" });
      const inOrder = [...rtts.entries()].sort(([a], [b]) => a - b).map(([, rtt]) => rtt);
      const relayed = await viaRelay(pc);
      finish({ hostId, status: "measured", link: linkOf(inOrder, relayed) });
    };

    channel.onmessage = ({ data }) => {
      const seq = Number(data);
      const at = sentAt.get(seq);
      if (at === undefined || rtts.has(seq)) return;
      rtts.set(seq, now() - at);
      if (rtts.size === PROBE_PINGS) void measure();
    };
    channel.onopen = () => {
      for (let seq = 0; seq < PROBE_PINGS; seq++) {
        timers.push(
          setTimeout(() => {
            if (channel.readyState !== "open") return;
            sentAt.set(seq, now());
            channel.send(String(seq));
          }, seq * PING_GAP_MS),
        );
      }
      timers.push(setTimeout(() => void measure(), (PROBE_PINGS - 1) * PING_GAP_MS + ECHO_WAIT_MS));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") finish({ hostId, status: "unreachable" });
    };

    register({
      target,
      pc,
      finish,
      answered: (sdp) => {
        if (answered || settled) return;
        answered = true;
        pc.setRemoteDescription(sdp).catch(() => finish({ hostId, status: "unreachable" }));
      },
      lost: () => {
        if (!answered) finish({ hostId, status: "unanswered" });
      },
    });

    void (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, GATHER_MS);
      if (settled || !pc.localDescription) return;
      send({ type: "probe", hostId, token: target.token, probeId, sdp: pc.localDescription.toJSON() });
    })().catch(() => finish({ hostId, status: "unanswered" }));
  });
}
