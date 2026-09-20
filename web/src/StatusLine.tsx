import { useEffect, useState } from "react";
import { selectedCandidateType, type CandidateType } from "./peer";

const CANDIDATE_MEANING: Record<CandidateType, string> = {
  host: "same local network — proves nothing about the internet path",
  srflx: "direct across the internet — this is the good case",
  relay: "going through TURN — working, and costing bandwidth",
  prflx: "peer-reflexive",
  unknown: "no candidate pair selected yet",
};

/**
 * Shows what the connection is actually doing. Both peers render this, because
 * "connected" alone hides whether the test was meaningful.
 */
export function StatusLine({ pc, note }: { pc: RTCPeerConnection | null; note?: string }) {
  const [state, setState] = useState<RTCPeerConnectionState>("new");
  const [candidate, setCandidate] = useState<CandidateType>("unknown");

  useEffect(() => {
    if (!pc) {
      setState("new");
      setCandidate("unknown");
      return;
    }

    const onChange = () => setState(pc.connectionState);
    onChange();
    pc.addEventListener("connectionstatechange", onChange);

    // Poll rather than read once: ICE can upgrade the selected pair after the
    // connection first reports connected.
    const timer = window.setInterval(() => {
      void selectedCandidateType(pc).then(setCandidate);
    }, 1000);

    return () => {
      pc.removeEventListener("connectionstatechange", onChange);
      window.clearInterval(timer);
    };
  }, [pc]);

  return (
    <p className="status">
      <span className={`dot dot-${state}`} />
      <strong>{state}</strong>
      {" · "}
      <strong>{candidate}</strong> <span className="muted">{CANDIDATE_MEANING[candidate]}</span>
      {note ? <span className="muted"> · {note}</span> : null}
    </p>
  );
}
