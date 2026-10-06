// Peer-connection helpers shared by the host and the renter.

export type CandidateType = "host" | "srflx" | "relay" | "prflx" | "unknown";

// Public STUN, across two operators on purpose.
//
// One server is one DNS lookup away from gathering no srflx candidate at all,
// which was seen happening here: a run where `stun.l.google.com` returned 701
// and the peer ended up with nothing but its LAN address. On one network that
// still connects, so the loss stays invisible until two peers are genuinely
// apart — the one case this project exists for.
//
// It is insurance, not a measured win: on a healthy network a single server
// gathers srflx just as reliably. Two operators rather than four addresses at
// one, because the failure being guarded against is a name that will not
// resolve and stun1 shares its domain with stun. Keep the list short — every
// server is another lookup before the connection can settle.
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type IceConfig = {
  iceServers?: RTCIceServer[];
  /** Set on BOTH peers to prove the relay path. Needs TURN credentials above. */
  forceRelay?: boolean;
};

/**
 * The TURN relays among `servers` (turn: or turns:), without STUN: what a
 * relay-only connection, such as one between a player and a crewmate watching
 * them, may use. Neither side then learns the other's address.
 */
export function relayOnly(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.filter((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url)),
  );
}

export function createPeerConnection({ iceServers, forceRelay }: IceConfig = {}): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: iceServers ?? DEFAULT_ICE_SERVERS,
    iceTransportPolicy: forceRelay ? "relay" : "all",
  });

  // Report the outcome, not every error along the way. A healthy connection
  // still logs a 701 per server — one per address family that fails to resolve
  // — so warning on each would cry wolf every single time and teach everyone to
  // ignore it. What actually matters is the end state: gathering finished and
  // nothing but LAN addresses came back, so this peer is unreachable from
  // anywhere else and will only ever connect to someone on the same network.
  const unreachable = new Set<string>();
  let reachedTheOutside = false;

  pc.addEventListener("icecandidateerror", (event) => {
    if (event.url) unreachable.add(`${event.url} (${event.errorCode} ${event.errorText})`);
  });

  pc.addEventListener("icecandidate", (event) => {
    const type = event.candidate?.type;
    if (type === "srflx" || type === "relay") reachedTheOutside = true;
  });

  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState !== "complete" || reachedTheOutside) return;
    console.warn(
      "[swiff] no srflx or relay candidate — this peer is only reachable on its own network.",
      unreachable.size ? `Unreachable ICE servers: ${[...unreachable].join(", ")}` : "",
    );
  });

  return pc;
}

// Which path ICE actually chose. This is the difference between "it works" and
// "it works for the reason I think":
//
//   host   same local network. Says NOTHING about the internet path.
//   srflx  direct across the internet via STUN. The good case.
//   relay  going through TURN. Working, and burning ~4.5 GB/hour.
//
// A LAN test reports `host` and proves nothing, which is why step 6 of the
// phase 1 plan tethers the renter to a phone.
/** Read this side's candidate type on the pair ICE selected, `unknown` before one is chosen. */
export async function selectedCandidateType(pc: RTCPeerConnection): Promise<CandidateType> {
  const stats = await pc.getStats();
  return candidateTypeOf(stats, selectedCandidatePair(stats)?.localCandidateId);
}

/**
 * The candidate pair ICE is using, or undefined before one is chosen.
 *
 * The transport report names it in `selectedCandidatePairId`, which is the
 * standard answer. Only when no transport names one does this fall back to a
 * pair marked `selected` (a Firefox-only field) or, last, one that `succeeded`.
 * Several pairs can succeed at once, so that last guess may be the wrong one.
 */
export function selectedCandidatePair(stats: RTCStatsReport): RTCIceCandidatePairStats | undefined {
  const pairs = new Map<string, RTCIceCandidatePairStats>();
  let selectedId: string | undefined;
  let marked: RTCIceCandidatePairStats | undefined;
  let succeeded: RTCIceCandidatePairStats | undefined;
  stats.forEach((report) => {
    if (report.type === "transport" && report.selectedCandidatePairId)
      selectedId = report.selectedCandidatePairId;
    if (report.type !== "candidate-pair") return;
    pairs.set(report.id, report);
    if (report.selected) marked = report;
    else if (report.state === "succeeded") succeeded = report;
  });
  return selectedId ? pairs.get(selectedId) : (marked ?? succeeded);
}

/** The type of the candidate with this id in a stats report, `unknown` when absent. */
export function candidateTypeOf(stats: RTCStatsReport, candidateId: string | undefined): CandidateType {
  let type: CandidateType = "unknown";
  if (!candidateId) return type;
  stats.forEach((report) => {
    if (report.id === candidateId && report.candidateType) type = report.candidateType as CandidateType;
  });
  return type;
}
