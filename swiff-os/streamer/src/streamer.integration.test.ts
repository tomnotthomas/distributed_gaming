// The streamer against the real server and a real peer connection: a renter
// books and claims the PC through the booking API, the test stands in for
// swiff-hostd (it starts the host session with the machine key and hands the
// streamer the session key), and a werift peer stands in for the renter's
// browser. Only the capture is faked: packets go in where the GStreamer helper
// would put them.
//
// It proves the parts a unit test cannot: that the server admits the streamer
// on its session key, that the offer is one a peer can answer, that video
// reaches the renter and their input reaches the sink, that a lost picture
// asks the encoder for a keyframe, and that the session ending puts the
// streamer out.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection, RtpHeader, RtpPacket, useH264, useOPUS, type RTCDataChannel } from "werift";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIceInbox, encodeInput, type InputSink, type SignalMessage } from "@swiff/rtc";
import { mintRenterSession } from "../../../server/src/access";
import { SESSION_COOKIE } from "../../../server/src/signin";
import { REPORT } from "../../../server/src/test/report";
import { createPeer } from "./peer";
import { steamLoginForwarder } from "./steamLogin";
import { startStreamer } from "./streamer";
import { VIDEO_PT } from "./pipeline";

const PORT = 9300 + Math.floor(Math.random() * 400);
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const SECRET = "streamer-integration-room-secret-long-enough";
const SESSION_SECRET = "streamer-integration-session-secret-long-enough";
/** A relay the server mints for and nobody dials: what reaches the streamer is checked, not used. */
const TURN_URLS = "turn:relay.invalid:3478";
const TURN_SECRET = "streamer-integration-turn-secret-long-enough";
const RENTER = {
  cookie: `${SESSION_COOKIE}=${mintRenterSession(SESSION_SECRET, "76561198000000001", 3600)}`,
};
const MACHINE_KEY = "streamer-integration-machine-key";
const MACHINE = "rental-pc-1";
const HOST = { authorization: `Bearer ${MACHINE_KEY}` };

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SERVER_ENTRY = resolve(
  REPO_ROOT,
  "server",
  (JSON.parse(readFileSync(resolve(REPO_ROOT, "server/package.json"), "utf8")) as { main: string }).main,
);

let server: ChildProcess;

beforeAll(async () => {
  // `npm test` builds the server workspace before this one runs.
  expect(existsSync(SERVER_ENTRY), "the server is not built: run `npm run build -w @swiff/server`").toBe(
    true,
  );
  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: resolve(REPO_ROOT, "server"),
    env: {
      ...process.env,
      PORT: String(PORT),
      ROOM_SECRET: SECRET,
      SESSION_SECRET,
      MACHINE_KEYS: `${MACHINE}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`,
      DATABASE_URL: "",
      TURN_URLS,
      TURN_SECRET,
      // Every game playable, so nothing here waits on or calls Steam (server/src/playable.ts).
      SWIFF_PLAYABILITY: "off",
    },
    stdio: "ignore",
  });
  // Without DATABASE_URL the server first boots an in-memory Postgres: slow on a loaded machine.
  const deadline = Date.now() + 80_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${HTTP_URL}/api/ping`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the server did not start");
}, 90_000);

afterAll(() => {
  server?.kill();
});

async function call(method: string, path: string, auth: Record<string, string>, body?: unknown) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method,
    headers: { ...auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>),
  };
}

async function until(check: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The renter's browser, as far as the streamer can tell: join, answer, receive, send input. */
function renterPeer(ticket: string) {
  // What a browser decodes, as far as this offer goes.
  const pc = new RTCPeerConnection({ iceServers: [], codecs: { video: [useH264()], audio: [useOPUS()] } });
  const channels = new Map<string, RTCDataChannel>();
  const payloads: Buffer[] = [];
  const offers: number[] = [];
  let videoSsrc: number | undefined;
  const ws = new WebSocket(SERVER_URL);
  const send = (m: SignalMessage) => ws.send(JSON.stringify(m));

  pc.onIceCandidate.subscribe((c) => c && send({ type: "ice", candidate: c.toJSON() }));
  pc.onDataChannel.subscribe((channel) => channels.set(channel.label, channel));
  pc.onTransceiverAdded.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      if (track.kind !== "video") return;
      track.onReceiveRtp.subscribe((rtp) => {
        videoSsrc = rtp.header.ssrc;
        payloads.push(rtp.payload);
      });
    });
  });
  ws.addEventListener("open", () => send({ type: "join", ticket }));
  // The streamer's candidates trickle after its offer: held until the offer is applied, as the page holds them.
  const inbox = createIceInbox(pc as unknown as globalThis.RTCPeerConnection);
  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(String(event.data)) as SignalMessage;
    if (msg.type === "offer") {
      offers.push(Date.now());
      await inbox.setRemote(msg.sdp as { type: "offer"; sdp: string });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: { type: "answer", sdp: pc.localDescription!.sdp } });
    } else if (msg.type === "ice" && msg.candidate) {
      inbox.add(msg.candidate);
    }
  });

  return {
    pc,
    channels,
    payloads,
    /** When each offer arrived. */
    offers,
    /** A PLI for the video, as a decoder that lost a frame sends one. */
    pictureLost: () => {
      const receiver = pc.getTransceivers().find((t) => t.kind === "video")!.receiver;
      void receiver.sendRtcpPLI(videoSsrc!);
    },
    close: async () => {
      ws.close();
      await pc.close();
    },
  };
}

/** What the input sink was asked to do, in order. */
function recordingSink() {
  const calls: string[] = [];
  const sink: InputSink = {
    move: (x, y) => calls.push(`move ${x.toFixed(2)} ${y.toFixed(2)}`),
    moveBy: (dx, dy) => calls.push(`moveBy ${dx} ${dy}`),
    wheel: (dx, dy) => calls.push(`wheel ${dx} ${dy}`),
    button: (b, down) => calls.push(`button ${b} ${down}`),
    key: (code, down) => calls.push(`key ${code} ${down}`),
    // A sink that fails, as a uinput write can: the streamer must outlive it.
    gamepad: () => {
      throw new Error("controller sink failed");
    },
  };
  return { calls, sink };
}

/** An RTP packet the way the capture helper frames one, with a recognisable payload. */
function videoPacket(seq: number): Buffer {
  const payload = Buffer.from([0x65, ...Buffer.from(`frame-${seq}`)]); // an IDR slice NAL header
  return new RtpPacket(
    new RtpHeader({
      payloadType: VIDEO_PT,
      sequenceNumber: seq,
      timestamp: seq * 1500,
      ssrc: 1234,
      marker: true,
    }),
    payload,
  ).serialize();
}

describe("swiff-streamer against the server", () => {
  it(
    "serves a renter on its session key: video out, input in, keyframes on request, out when the session ends",
    { timeout: 60_000 },
    async () => {
      // The PC is offered, a renter books and claims it.
      const offered = await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
        available: true,
        ...REPORT,
      });
      expect(offered.status).toBe(200);
      const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      expect(booking.body).toMatchObject({ status: "matched" });
      const claim = await call("POST", `/api/bookings/${booking.body!.bookingId}/claim`, RENTER);
      expect(claim.status).toBe(200);
      const sessionId = claim.body!.sessionId as string;

      // swiff-hostd's part: start the host session and hand the streamer the key.
      const grant = await call("POST", `/api/machines/${MACHINE}/session`, HOST, { sessionId });
      expect(grant.status).toBe(201);

      const { calls, sink } = recordingSink();
      const logs: string[] = [];
      const offeredIce: RTCIceServer[][] = [];
      let keyframes = 0;
      const streamer = startStreamer({
        config: { serverUrl: SERVER_URL, hostId: MACHINE, audio: "off" },
        grant: { sessionKey: grant.body!.sessionKey as string, expiresAt: grant.body!.expiresAt as number },
        input: sink,
        onKeyframeNeeded: () => keyframes++,
        // Loopback needs no STUN or TURN, and a test should not depend on reaching Google.
        makePeer: (options) => {
          offeredIce.push(options.iceServers);
          return createPeer({ ...options, iceServers: [] });
        },
        log: (line) => logs.push(line),
      });

      const renter = renterPeer(claim.body!.ticket as string);
      let seq = 0;
      const feed = setInterval(() => streamer.send("video", videoPacket(++seq)), 20);
      try {
        await until(() => renter.payloads.length > 0, "video at the renter");
        // The PC was offered the relay with a credential of its own for this
        // session, expiring when the session's 30 minutes do.
        const relay = offeredIce[0]!.find((server) => server.username);
        expect(relay).toMatchObject({ urls: [TURN_URLS] });
        const [expiry, who] = relay!.username!.split(":");
        expect(who).toBe(`${sessionId}-host`);
        expect(Math.abs(Number(expiry) - (Date.now() / 1000 + 30 * 60))).toBeLessThan(120);
        expect(relay!.credential).toBe(
          createHmac("sha1", TURN_SECRET).update(relay!.username!).digest("base64"),
        );
        // A keyframe was asked for the moment the connection came up.
        await until(() => keyframes >= 1, "the keyframe request when the connection came up");
        expect(renter.payloads[0]!.toString("latin1")).toMatch(/^\x65frame-\d+$/);

        // The renter's input arrives in order on the reliable lane, and moves on the fast one.
        await until(() => renter.channels.size === 2, "both input channels");
        const keys = renter.channels.get("input-keys")!;
        const motion = renter.channels.get("input-motion")!;
        await until(() => keys.readyState === "open" && motion.readyState === "open", "the channels open");
        keys.send(Buffer.from(encodeInput({ type: "key", code: "KeyW", down: true })));
        motion.send(Buffer.from(encodeInput({ type: "move-by", dx: 5, dy: -3 })));
        keys.send(Buffer.from(encodeInput({ type: "key", code: "KeyW", down: false })));
        await until(() => calls.includes("key KeyW false"), "the renter's input at the sink");
        expect(calls).toContain("key KeyW true");
        expect(calls).toContain("moveBy 5 -3");

        // A sink that throws is logged, and the next input still gets through.
        keys.send(
          Buffer.from(
            encodeInput({
              type: "gamepad",
              index: 0,
              state: { buttons: 1, axes: [0, 0, 0, 0], triggers: [0, 0] },
            }),
          ),
        );
        keys.send(Buffer.from(encodeInput({ type: "key", code: "KeyA", down: true })));
        keys.send(Buffer.from(encodeInput({ type: "key", code: "KeyA", down: false })));
        await until(() => calls.includes("key KeyA false"), "input after a failing sink");
        expect(logs.some((l) => l.includes("input delivery failed: controller sink failed"))).toBe(true);

        // A decoder that lost a frame asks for a keyframe, and the encoder is told.
        const before = keyframes;
        renter.pictureLost();
        await until(() => keyframes > before, "the keyframe request");

        // The renter leaves; the server ends the session and puts the streamer out.
        const left = await call("POST", `/api/sessions/${sessionId}/leave`, {
          authorization: `Bearer ${claim.body!.ticket as string}`,
        });
        expect(left.status).toBe(200);
        expect(await streamer.ended).toBe("session-ended");
        // Letting go of the held controller on the way out failed too, and was logged, not thrown.
        expect(logs.some((l) => l.includes("input release failed: controller sink failed"))).toBe(true);
      } finally {
        clearInterval(feed);
        streamer.stop();
        await renter.close();
      }
    },
  );

  it(
    "offers at once however long werift takes to gather, and applies the renter's answer only once it has",
    { timeout: 60_000 },
    async () => {
      const offered = await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
        available: true,
        ...REPORT,
      });
      expect(offered.status).toBe(200);
      const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      const claim = await call("POST", `/api/bookings/${booking.body!.bookingId}/claim`, RENTER);
      expect(claim.status).toBe(200);
      const sessionId = claim.body!.sessionId as string;
      const grant = await call("POST", `/api/machines/${MACHINE}/session`, HOST, { sessionId });
      expect(grant.status).toBe(201);

      // A STUN server that never answers (TEST-NET-1): werift holds its gathering for it, up
      // to 5 s, longer than a reconnecting renter waits for an offer before it joins again (4 s).
      const GATHER_MS = 5_000;
      let gathered = 0;
      let answered = 0;
      const streamer = startStreamer({
        config: { serverUrl: SERVER_URL, hostId: MACHINE, audio: "off" },
        grant: { sessionKey: grant.body!.sessionKey as string, expiresAt: grant.body!.expiresAt as number },
        input: recordingSink().sink,
        onKeyframeNeeded: () => {},
        makePeer: (options) => {
          const peer = createPeer({ ...options, iceServers: [{ urls: "stun:192.0.2.1:3478" }] });
          // werift's own (private) gathering, which its setLocalDescription waits for.
          const pc = peer.pc as unknown as { gatherCandidates(): Promise<void> };
          const gather = pc.gatherCandidates.bind(pc);
          pc.gatherCandidates = async () => {
            await gather();
            gathered = Date.now();
          };
          // The renter's answer, which starts werift's checks.
          const setRemote = peer.pc.setRemoteDescription.bind(peer.pc);
          peer.pc.setRemoteDescription = (sdp) => {
            answered ||= Date.now();
            return setRemote(sdp);
          };
          return peer;
        },
        log: () => {},
      });
      const renter = renterPeer(claim.body!.ticket as string);
      const joined = Date.now();
      let seq = 0;
      const feed = setInterval(() => streamer.send("video", videoPacket(++seq)), 20);
      try {
        await until(() => renter.offers.length > 0, "the offer");
        expect(renter.offers[0]! - joined).toBeLessThan(2_000);
        await until(() => renter.payloads.length > 0, "video at the renter", 30_000);
        // werift waited on the STUN server, and only then took the renter's answer:
        // it pairs a relay candidate only with remote candidates that come after it.
        expect(gathered).toBeGreaterThan(0);
        expect(gathered - renter.offers[0]!).toBeGreaterThanOrEqual(GATHER_MS - 1_000);
        expect(answered).toBeGreaterThanOrEqual(gathered);
        const left = await call("POST", `/api/sessions/${sessionId}/leave`, {
          authorization: `Bearer ${claim.body!.ticket as string}`,
        });
        expect(left.status).toBe(200);
        expect(await streamer.ended).toBe("session-ended");
      } finally {
        clearInterval(feed);
        streamer.stop();
        await renter.close();
      }
    },
  );

  it(
    "carries a rental-mode renter's Steam sign-in: the code out, a retry back, and game-started once the game runs",
    { timeout: 60_000 },
    async () => {
      // A stand-in for swiff-steam-login on its socket: it records each Play and answers as the test says.
      const dir = mkdtempSync(join(tmpdir(), "swiff-steam-"));
      const agentPath = join(dir, "login.sock");
      const plays: { command: string; conn: Socket }[] = [];
      const agent = createServer((conn) => {
        conn.setEncoding("utf8");
        conn.on("data", (command: string) => plays.push({ command, conn }));
      });
      await new Promise<void>((done) => agent.listen(agentPath, done));
      const agentSays = (...events: object[]) =>
        plays.at(-1)!.conn.write(events.map((e) => `${JSON.stringify(e)}\n`).join(""));

      const offered = await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
        available: true,
        ...REPORT,
      });
      expect(offered.status).toBe(200);
      const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
      expect(booking.body).toMatchObject({ status: "matched" });
      const claim = await call("POST", `/api/bookings/${booking.body!.bookingId}/claim`, RENTER);
      expect(claim.status).toBe(200);
      const sessionId = claim.body!.sessionId as string;
      const ticket = claim.body!.ticket as string;
      const grant = await call("POST", `/api/machines/${MACHINE}/session`, HOST, { sessionId });
      expect(grant.status).toBe(201);

      const streamer = startStreamer({
        config: { serverUrl: SERVER_URL, hostId: MACHINE, audio: "off" },
        grant: { sessionKey: grant.body!.sessionKey as string, expiresAt: grant.body!.expiresAt as number },
        input: recordingSink().sink,
        onKeyframeNeeded: () => {},
        steamLogin: steamLoginForwarder({ socketPath: agentPath, appid: 730, log: () => {} }),
        makePeer: (options) => createPeer({ ...options, iceServers: [] }),
        log: () => {},
      });

      // The renter's page, as far as signaling goes: it joins with its ticket and hears the PC.
      const heard: SignalMessage[] = [];
      const ws = new WebSocket(SERVER_URL);
      const send = (m: SignalMessage) => ws.send(JSON.stringify(m));
      ws.addEventListener("open", () => send({ type: "join", ticket }));
      ws.addEventListener("message", (event) => heard.push(JSON.parse(String(event.data)) as SignalMessage));
      const steam = () => heard.filter((m) => m.type === "steam-login");
      try {
        // The renter is in the room: the PC asks Steam for its code before any stream.
        await until(() => plays.length === 1, "the Play at the agent");
        expect(plays[0]!.command).toBe("play 730\n");
        agentSays({ event: "qr", url: "https://s.team/q/1/42", atMs: 50 });
        await until(() => steam().length === 1, "the code at the renter");
        expect(steam()[0]).toEqual({ type: "steam-login", state: "qr", url: "https://s.team/q/1/42" });

        // The code timed out: the renter hears it, asks for a new one, and the PC plays afresh.
        agentSays({ event: "failed", reason: "sign-in-timeout", atMs: 600_000 });
        plays[0]!.conn.end();
        await until(() => steam().length === 2, "the failure at the renter");
        expect(steam()[1]).toEqual({ type: "steam-login", state: "failed", reason: "sign-in-timeout" });
        send({ type: "steam-login", state: "retry" });
        await until(() => plays.length === 2, "the fresh Play after the retry");
        expect(plays[1]!.command).toBe("play 730\n");

        agentSays(
          { event: "qr", url: "https://s.team/q/1/43", atMs: 40 },
          { event: "signed-in", atMs: 9_000 },
          { event: "launching", appid: 730, atMs: 9_100 },
          { event: "game-on-screen", appid: 730, atMs: 21_000 },
        );
        await until(() => steam().length === 4, "the new code and the sign-in at the renter");
        expect(steam().slice(2)).toEqual([
          { type: "steam-login", state: "qr", url: "https://s.team/q/1/43" },
          { type: "steam-login", state: "signed-in" },
        ]);

        // The page starts the session on its first frame; the server asks the PC to launch, and the game runs.
        const started = await call("POST", `/api/sessions/${sessionId}/start`, {
          authorization: `Bearer ${ticket}`,
        });
        expect(started.status).toBe(200);
        await until(() => heard.some((m) => m.type === "game-started"), "game-started at the renter");
        expect(heard.find((m) => m.type === "game-started")).toEqual({ type: "game-started", sessionId });

        const left = await call("POST", `/api/sessions/${sessionId}/leave`, {
          authorization: `Bearer ${ticket}`,
        });
        expect(left.status).toBe(200);
        expect(await streamer.ended).toBe("session-ended");
      } finally {
        streamer.stop();
        ws.close();
        await new Promise((done) => agent.close(done));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
