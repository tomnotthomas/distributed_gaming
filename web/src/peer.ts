// Peer-connection helpers shared by the host and the renter.

import { FORCE_RELAY, ICE_SERVERS } from "./config";

export type CandidateType = "host" | "srflx" | "relay" | "prflx" | "unknown";

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: FORCE_RELAY ? "relay" : "all",
  });
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
export async function selectedCandidateType(pc: RTCPeerConnection): Promise<CandidateType> {
  const stats = await pc.getStats();

  let pairId: string | undefined;
  stats.forEach((report) => {
    // Chrome marks the winning pair `selected`; Firefox only reports `succeeded`.
    if (report.type === "candidate-pair" && (report.selected || report.state === "succeeded")) {
      pairId = report.localCandidateId;
    }
  });
  if (!pairId) return "unknown";

  let type: CandidateType = "unknown";
  stats.forEach((report) => {
    if (report.id === pairId && report.candidateType) type = report.candidateType as CandidateType;
  });
  return type;
}
