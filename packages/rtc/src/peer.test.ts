// Unit tests for the peer helpers.
//
// `selectedCandidateType` is the one piece of code that decides whether a test
// run means anything: it is what tells you a connection went `srflx` across the
// internet rather than `host` over the wifi you were already on. The browser
// differences it papers over (Chrome marks the winning pair `selected`, Firefox
// only ever says `succeeded`) are exactly what regresses silently, so both are
// pinned here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerConnection, selectedCandidateType, DEFAULT_ICE_SERVERS } from "./peer";

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

/**
 * Stub `RTCPeerConnection` and hand back the constructor spy.
 *
 * The instance records its listeners, because `createPeerConnection` subscribes
 * to `icecandidateerror` and a test needs to be able to fire it.
 */
function stubPeerConnection() {
  const listeners = new Map<string, (event: unknown) => void>();
  const spy = vi.fn(function (this: Record<string, unknown>, _config: RTCConfiguration) {
    this.addEventListener = (type: string, fn: (event: unknown) => void) => listeners.set(type, fn);
  });
  vi.stubGlobal("RTCPeerConnection", spy);
  return { spy, fire: (type: string, event: unknown) => listeners.get(type)?.(event) };
}

describe("createPeerConnection", () => {
  it("falls back to the default STUN servers", () => {
    const { spy } = stubPeerConnection();

    createPeerConnection();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  // The whole point of the default list: one name failing to resolve must not
  // cost every srflx candidate, and two entries on one domain share a lookup.
  it("defaults to STUN on more than one operator", () => {
    const urls = DEFAULT_ICE_SERVERS.flatMap((server) => [server.urls].flat());

    expect(urls.length).toBeGreaterThan(1);
    expect(urls.some((url) => !url.includes("google.com"))).toBe(true);
  });

  it("passes caller-supplied ICE servers through", () => {
    const { spy } = stubPeerConnection();
    const iceServers = [{ urls: "turn:example:3478", username: "u", credential: "p" }];

    createPeerConnection({ iceServers });

    expect(spy.mock.calls[0][0].iceServers).toEqual(iceServers);
  });

  it("leaves the transport policy open unless relay is forced", () => {
    const { spy } = stubPeerConnection();

    createPeerConnection();
    expect(spy.mock.calls[0][0].iceTransportPolicy).toBe("all");

    createPeerConnection({ forceRelay: true });
    expect(spy.mock.calls[1][0].iceTransportPolicy).toBe("relay");
  });

  // Gathering nothing but LAN addresses means this peer cannot be reached from
  // anywhere else. It used to happen in total silence, and on one network it
  // still connects, so nobody finds out until a renter somewhere else cannot.
  it("warns when gathering finishes with no route off the local network", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, fire } = stubPeerConnection();

    createPeerConnection();
    fire("icecandidateerror", {
      url: "stun:stun.l.google.com:19302",
      errorCode: 701,
      errorText: "STUN host lookup received error",
    });
    fire("icecandidate", { candidate: { type: "host" } });
    spy.mock.instances[0].iceGatheringState = "complete";
    fire("icegatheringstatechange", {});

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0].join(" ")).toContain("only reachable on its own network");
    expect(warn.mock.calls[0].join(" ")).toContain("stun.l.google.com");
    warn.mockRestore();
  });

  // The noisy case this deliberately stays quiet for: a 701 per address family
  // is normal, and srflx still came back. Warning here would train people to
  // ignore the warning that matters.
  it("stays silent when a server errored but a srflx candidate still arrived", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, fire } = stubPeerConnection();

    createPeerConnection();
    fire("icecandidateerror", {
      url: "stun:stun.l.google.com:19302",
      errorCode: 701,
      errorText: "STUN host lookup received error",
    });
    fire("icecandidate", { candidate: { type: "srflx" } });
    spy.mock.instances[0].iceGatheringState = "complete";
    fire("icegatheringstatechange", {});

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says nothing until gathering is actually complete", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, fire } = stubPeerConnection();

    createPeerConnection();
    spy.mock.instances[0].iceGatheringState = "gathering";
    fire("icegatheringstatechange", {});

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
