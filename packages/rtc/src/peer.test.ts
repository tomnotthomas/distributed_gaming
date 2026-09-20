// Unit tests for the peer helpers.
//
// `selectedCandidateType` is the one piece of code that decides whether a test
// run means anything: it is what tells you a connection went `srflx` across the
// internet rather than `host` over the wifi you were already on. The browser
// differences it papers over (Chrome marks the winning pair `selected`, Firefox
// only ever says `succeeded`) are exactly what regresses silently, so both are
// pinned here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerConnection, selectedCandidateType } from "./peer";
import { FORCE_RELAY, ICE_SERVERS } from "./config";

/** A stats report is Map-like — `getStats` callers only ever use forEach. */
function statsReport(reports: Record<string, unknown>[]) {
  return {
    forEach(fn: (report: Record<string, unknown>) => void) {
      reports.forEach(fn);
    },
  };
}

function pcWithStats(reports: Record<string, unknown>[]) {
  return { getStats: async () => statsReport(reports) } as unknown as RTCPeerConnection;
}

afterEach(() => vi.unstubAllGlobals());

describe("createPeerConnection", () => {
  it("passes the configured ICE servers through", () => {
    const spy = vi.fn();
    vi.stubGlobal("RTCPeerConnection", spy);

    createPeerConnection();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].iceServers).toEqual(ICE_SERVERS);
  });

  it("leaves the transport policy open unless relay is forced", () => {
    const spy = vi.fn();
    vi.stubGlobal("RTCPeerConnection", spy);

    createPeerConnection();

    // FORCE_RELAY is a build-time constant; assert the mapping either way so
    // this test keeps its meaning when someone flips it to debug TURN.
    expect(spy.mock.calls[0][0].iceTransportPolicy).toBe(FORCE_RELAY ? "relay" : "all");
  });
});

describe("selectedCandidateType", () => {
  it("returns unknown when ICE has not picked a pair yet", async () => {
    const pc = pcWithStats([{ type: "candidate-pair", state: "in-progress", localCandidateId: "c1" }]);
    expect(await selectedCandidateType(pc)).toBe("unknown");
  });

  it("returns unknown when there are no stats at all", async () => {
    expect(await selectedCandidateType(pcWithStats([]))).toBe("unknown");
  });

  it("reads the winning pair that Chrome marks selected", async () => {
    const pc = pcWithStats([
      { type: "candidate-pair", selected: true, localCandidateId: "c-win" },
      { id: "c-win", type: "local-candidate", candidateType: "srflx" },
      { id: "c-lose", type: "local-candidate", candidateType: "host" },
    ]);
    expect(await selectedCandidateType(pc)).toBe("srflx");
  });

  it("reads the winning pair that Firefox only marks succeeded", async () => {
    const pc = pcWithStats([
      { type: "candidate-pair", state: "succeeded", localCandidateId: "c-win" },
      { id: "c-win", type: "local-candidate", candidateType: "relay" },
    ]);
    expect(await selectedCandidateType(pc)).toBe("relay");
  });

  it("reports host when the two peers are on the same LAN", async () => {
    const pc = pcWithStats([
      { type: "candidate-pair", selected: true, localCandidateId: "lan" },
      { id: "lan", type: "local-candidate", candidateType: "host" },
    ]);
    // The status line leans on this to warn that a LAN test proves nothing.
    expect(await selectedCandidateType(pc)).toBe("host");
  });

  it("returns unknown when the pair names a candidate that is not in the report", async () => {
    const pc = pcWithStats([{ type: "candidate-pair", selected: true, localCandidateId: "missing" }]);
    expect(await selectedCandidateType(pc)).toBe("unknown");
  });

  it("ignores candidate-pair reports that lost", async () => {
    const pc = pcWithStats([
      { type: "candidate-pair", state: "failed", localCandidateId: "c-failed" },
      { type: "candidate-pair", selected: true, localCandidateId: "c-win" },
      { id: "c-failed", type: "local-candidate", candidateType: "host" },
      { id: "c-win", type: "local-candidate", candidateType: "srflx" },
    ]);
    expect(await selectedCandidateType(pc)).toBe("srflx");
  });
});
