// The latency-probe relay, with stand-in sockets and a clock moved by hand.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mintProbeToken, mintTicket, type RenterSession } from "../access.js";
import { PROBE_BURST, PROBE_REFILL_MS, PROBE_TOKEN_TTL_S, ProbeRelay } from "../probes.js";
import type { ProbeMessage, SignalMessage } from "../protocol.js";

const SECRET = "test-session-secret-that-is-long-enough-too";
const RENTER = "76561198000000001";
const OTHER = "76561198000000002";
const OFFER = { type: "offer", sdp: "v=0 offer" } as const;
const ANSWER = { type: "answer", sdp: "v=0 answer" } as const;

/** A socket that keeps what it was sent. */
type Socket = { name: string; got: SignalMessage[] };
const socket = (name: string): Socket => ({ name, got: [] });

describe("probe relay", () => {
  let now: number;
  let relay: ProbeRelay<Socket>;
  let hosts: Map<string, Socket>;
  let renter: Socket;
  const session = (steamId = RENTER, exp = now / 1000 + 3600): RenterSession => ({ steamId, exp });
  const token = (host = "pc-1", who = RENTER, at = now) =>
    mintProbeToken(SECRET, { renter: who, host }, PROBE_TOKEN_TTL_S, at);
  const probe = (fields: Partial<ProbeMessage> = {}): ProbeMessage => ({
    type: "probe",
    hostId: "pc-1",
    token: token(fields.hostId),
    probeId: "mine-1",
    sdp: OFFER,
    ...fields,
  });

  beforeEach(() => {
    now = Date.now();
    hosts = new Map([["pc-1", socket("pc-1")]]);
    renter = socket("renter");
    relay = new ProbeRelay<Socket>({
      secret: SECRET,
      send: (to, msg) => to.got.push(msg),
      hostSocket: (id) => hosts.get(id) ?? null,
      now: () => now,
    });
  });

  afterEach(() => relay.close());

  it("relays the offer to the PC under an id of its own, and the answer back under the renter's", () => {
    relay.probe(renter, session(), probe());
    const host = hosts.get("pc-1")!;
    const [offer] = host.got as Extract<SignalMessage, { type: "probe-offer" }>[];
    assert.equal(offer?.type, "probe-offer");
    assert.deepEqual(offer.sdp, OFFER);
    assert.notEqual(offer.probeId, "mine-1", "the renter's id never reaches the PC");
    assert.deepEqual(renter.got, []);

    relay.answer(host, { type: "probe-answer", probeId: offer.probeId, sdp: ANSWER });
    assert.deepEqual(renter.got, [{ type: "probe-answer", probeId: "mine-1", sdp: ANSWER }]);
    assert.equal(relay.pending, 0);

    // Once only.
    relay.answer(host, { type: "probe-answer", probeId: offer.probeId, sdp: ANSWER });
    assert.equal(renter.got.length, 1);
  });

  it("refuses a renter who is not signed in, or whose token is not theirs, for that machine, or live", () => {
    hosts.set("pc-2", socket("pc-2"));
    const refusals: [RenterSession | null, ProbeMessage][] = [
      [null, probe()],
      [session(RENTER, now / 1000 - 1), probe()], // signed out since the socket opened
      [session(OTHER), probe()], // somebody else's token
      [session(), probe({ token: token("pc-2") })], // for another machine
      [session(), probe({ token: token("pc-1", RENTER, now - PROBE_TOKEN_TTL_S * 1000) })], // expired
      [session(), probe({ token: mintProbeToken(`${SECRET}-other`, { renter: RENTER, host: "pc-1" }, 60) })],
      [session(), probe({ token: mintTicket(SECRET, "pc-1", 60) })], // a ticket is not a probe token
      [session(), probe({ token: "garbage" })],
    ];
    for (const [who, msg] of refusals) relay.probe(renter, who, msg);
    assert.deepEqual(
      renter.got,
      refusals.map(() => ({ type: "probe-refused", probeId: "mine-1", reason: "bad-token" })),
    );
    assert.deepEqual(hosts.get("pc-1")!.got, []);
    assert.deepEqual(hosts.get("pc-2")!.got, []);
  });

  it("spends each token on one probe", () => {
    const once = probe();
    relay.probe(renter, session(), once);
    relay.probe(renter, session(), once);
    assert.equal(hosts.get("pc-1")!.got.length, 1);
    assert.deepEqual(renter.got, [{ type: "probe-refused", probeId: "mine-1", reason: "bad-token" }]);
  });

  it("lets a renter start 20 probes a minute", () => {
    for (let i = 0; i < PROBE_BURST; i++) relay.probe(renter, session(), probe());
    assert.equal(hosts.get("pc-1")!.got.length, PROBE_BURST);
    const over = probe();
    relay.probe(renter, session(), over);
    assert.deepEqual(renter.got, [{ type: "probe-refused", probeId: "mine-1", reason: "too-many" }]);
    // Another renter has their own.
    relay.probe(socket("other"), session(OTHER), probe({ token: token("pc-1", OTHER) }));
    assert.equal(hosts.get("pc-1")!.got.length, PROBE_BURST + 1);
    // The refused token was not spent: it goes through once there is room again.
    now += PROBE_REFILL_MS;
    relay.probe(renter, session(), over);
    assert.equal(hosts.get("pc-1")!.got.length, PROBE_BURST + 2);
    assert.equal(60_000 / PROBE_REFILL_MS, 20);
  });

  it("says when the machine is not connected, without spending the token", () => {
    const msg = probe({ hostId: "pc-9" });
    relay.probe(renter, session(), msg);
    assert.deepEqual(renter.got, [{ type: "probe-refused", probeId: "mine-1", reason: "host-offline" }]);
    hosts.set("pc-9", socket("pc-9"));
    relay.probe(renter, session(), msg);
    assert.equal(hosts.get("pc-9")!.got.length, 1);
  });

  it("takes the answer only from the socket the offer went to", () => {
    relay.probe(renter, session(), probe());
    const [offer] = hosts.get("pc-1")!.got as Extract<SignalMessage, { type: "probe-offer" }>[];
    relay.answer(socket("pc-1 again"), { type: "probe-answer", probeId: offer!.probeId, sdp: ANSWER });
    relay.answer(hosts.get("pc-1")!, { type: "probe-answer", probeId: "made-up", sdp: ANSWER });
    assert.deepEqual(renter.got, []);
    assert.equal(relay.pending, 1);
  });

  it("forgets a probe when either side goes, or the answer is too slow", async () => {
    relay.probe(renter, session(), probe());
    relay.forget(renter);
    assert.equal(relay.pending, 0);

    relay.probe(renter, session(), probe());
    relay.forget(hosts.get("pc-1")!);
    assert.equal(relay.pending, 0);

    relay = new ProbeRelay<Socket>({
      secret: SECRET,
      send: (to, msg) => to.got.push(msg),
      hostSocket: (id) => hosts.get(id) ?? null,
      waitMs: 10,
    });
    relay.probe(renter, session(), probe());
    assert.equal(relay.pending, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(relay.pending, 0);
  });

  it("drops a probe or answer with no usable id or description, unanswered", () => {
    const bad: Partial<ProbeMessage>[] = [
      { probeId: "" },
      { probeId: "x".repeat(65) },
      { sdp: { type: "answer", sdp: "v=0" } },
      { sdp: { type: "offer", sdp: "x".repeat(16 * 1024 + 1) } },
      { sdp: null as unknown as RTCSessionDescriptionInit },
    ];
    for (const fields of bad) relay.probe(renter, session(), probe(fields));
    assert.deepEqual(renter.got, []);
    assert.deepEqual(hosts.get("pc-1")!.got, []);

    relay.probe(renter, session(), probe());
    const [offer] = hosts.get("pc-1")!.got as Extract<SignalMessage, { type: "probe-offer" }>[];
    relay.answer(hosts.get("pc-1")!, { type: "probe-answer", probeId: offer!.probeId, sdp: OFFER });
    assert.deepEqual(renter.got, [], "an offer is not an answer");
  });

  it("refuses every probe when no secret is configured", () => {
    relay = new ProbeRelay<Socket>({
      secret: null,
      send: (to, msg) => to.got.push(msg),
      hostSocket: (id) => hosts.get(id) ?? null,
    });
    relay.probe(renter, session(), probe());
    assert.deepEqual(renter.got, [{ type: "probe-refused", probeId: "mine-1", reason: "bad-token" }]);
  });
});
