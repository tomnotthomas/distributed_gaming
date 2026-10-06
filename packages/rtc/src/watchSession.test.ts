// A viewer's watch session against a fake socket and connection: it takes its
// seat with the watch ticket, answers the player's offer view only (no data
// channel made or kept, no input read), plays the picture with the game's
// sound and each voice on its own line, and asks for the microphone only on
// joining the voice chat.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalMessage } from "./signaling";
import { FakeSocket } from "./test/fakes";
import { FakeMediaPeer, FakeMediaStream, FakeSender, FakeTrack } from "./test/media";
import { startWatchSession, type WatchSessionEvent } from "./watchSession";

const URL = "wss://signal.test";
const TICKET = "watch-ticket";
const OFFER = { type: "offer", sdp: "v=0 hub offer" } as const;
const flush = () => vi.advanceTimersByTimeAsync(0);

let video: HTMLVideoElement;
let mic: FakeTrack;
let getMicrophone: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeMediaPeer.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakeMediaPeer);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  HTMLMediaElement.prototype.play = vi.fn(async () => {}) as unknown as HTMLMediaElement["play"];
  video = document.createElement("video");
  document.body.append(video);
  mic = new FakeTrack("audio");
  getMicrophone = vi.fn(async () => new FakeMediaStream([mic]));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const peer = () => FakeMediaPeer.instances[FakeMediaPeer.instances.length - 1]!;

function start() {
  const session = startWatchSession({
    url: URL,
    ticket: TICKET,
    video,
    getMicrophone: getMicrophone as unknown as () => Promise<MediaStream>,
  });
  const events: WatchSessionEvent[] = [];
  session.on((event) => events.push(event));
  socket().accept();
  return { session, events };
}

async function offered() {
  socket().deliver({ type: "watching", watchId: "w1", state: "watching", player: "Mara", playerHere: true });
  socket().deliver({ type: "offer", sdp: OFFER, watchId: "w1" });
  await flush();
  return peer();
}

const sentOf = <T extends SignalMessage["type"]>(type: T) =>
  socket().messages.filter((m): m is Extract<SignalMessage, { type: T }> => m.type === type);

describe("startWatchSession", () => {
  it("takes its seat with the watch ticket and says where the watch stands", () => {
    const { events } = start();
    expect(socket().messages).toEqual([{ type: "watch", ticket: TICKET }]);
    socket().deliver({ type: "watching", watchId: "w1", state: "asking", player: "Mara", playerHere: true });
    expect(events).toEqual([{ type: "watching", state: "asking", player: "Mara", playerHere: true }]);
    expect(FakeMediaPeer.instances).toHaveLength(0);
  });

  it("answers the player's offer view only: no data channel made, and any offered one closed", async () => {
    start();
    const pc = await offered();
    expect(sentOf("answer")).toEqual([{ type: "answer", sdp: { type: "answer", sdp: "v=0 answer" } }]);
    expect(pc.dataChannels).toEqual([]);
    const channel = { label: "swiff-input-keys", close: vi.fn() };
    pc.ondatachannel?.({ channel });
    expect(channel.close).toHaveBeenCalled();
    // The only thing it could ever send is its voice, on the voice line.
    expect(pc.transceivers.map((t) => t.direction)).toEqual([
      "recvonly",
      "recvonly",
      "sendrecv",
      "recvonly",
      "recvonly",
      "recvonly",
    ]);
  });

  it("plays the picture with the game's sound, and each voice on a line of its own", async () => {
    start();
    const pc = await offered();
    const picture = video.srcObject as unknown as FakeMediaStream;
    expect(picture.getTracks()).toEqual([
      pc.transceivers[0]!.receiver.track,
      pc.transceivers[1]!.receiver.track,
    ]);
    expect(
      [...document.querySelectorAll("audio")].map((a) => (a as HTMLAudioElement).dataset.voiceMid),
    ).toEqual(["2", "3", "4", "5"]);
  });

  it("asks for the microphone only on joining the voice chat, and tells the player", async () => {
    const { session, events } = start();
    const pc = await offered();
    expect(getMicrophone).not.toHaveBeenCalled();
    expect(pc.sending()).toEqual([null, null, null, null, null, null]);
    expect(sentOf("crew").at(-1)).toEqual({
      type: "crew",
      data: { kind: "voice", inVoice: false, muted: false },
    });

    await session.joinVoice();
    expect(getMicrophone).toHaveBeenCalledTimes(1);
    expect(pc.sending()[2]).toBe(mic.id);
    expect(sentOf("crew").at(-1)).toEqual({
      type: "crew",
      data: { kind: "voice", inVoice: true, muted: false },
    });
    expect(events.filter((e) => e.type === "voice").at(-1)).toMatchObject({ voice: { inVoice: true } });

    session.setMuted(true);
    expect(mic.enabled).toBe(false);
    expect(sentOf("crew").at(-1)).toEqual({
      type: "crew",
      data: { kind: "voice", inVoice: true, muted: true },
    });

    session.leaveVoice();
    await flush();
    expect(pc.sending()[2]).toBeNull();
    expect(mic.stopped).toBe(true);
  });

  it("sends a microphone it already has on a new connection from the player", async () => {
    const { session } = start();
    await offered();
    await session.joinVoice();
    socket().deliver({ type: "offer", sdp: OFFER, watchId: "w1" });
    await flush();
    expect(FakeMediaPeer.instances).toHaveLength(2);
    expect(FakeMediaPeer.instances[0]!.closed).toBe(true);
    expect(peer().sending()[2]).toBe(mic.id);
  });

  it("keeps only the newest connection's voices and stats when a new offer comes while the microphone goes on", async () => {
    const { session } = start();
    await session.joinVoice();
    let release = () => {};
    const replaceTrack = FakeSender.prototype.replaceTrack;
    const held = vi.spyOn(FakeSender.prototype, "replaceTrack").mockImplementationOnce(function (
      this: FakeSender,
      track: FakeTrack | null,
    ) {
      return new Promise<void>((resolve) => {
        release = () => void replaceTrack.call(this, track).then(resolve);
      });
    });
    socket().deliver({ type: "watching", watchId: "w1", state: "watching", player: "Mara", playerHere: true });
    socket().deliver({ type: "offer", sdp: OFFER, watchId: "w1" });
    await flush();
    const first = peer();
    socket().deliver({ type: "offer", sdp: OFFER, watchId: "w1" });
    await flush();
    release();
    await flush();
    held.mockRestore();

    expect(FakeMediaPeer.instances).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(
      [...document.querySelectorAll("audio")].map((a) => (a as HTMLAudioElement).dataset.voiceMid),
    ).toEqual(["2", "3", "4", "5"]);
    const firstStats = vi.spyOn(first, "getStats");
    const latestStats = vi.spyOn(peer(), "getStats");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(firstStats).not.toHaveBeenCalled();
    expect(latestStats).toHaveBeenCalled();
    session.end();
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });

  it("goes quiet when the player mutes the viewer, and hears again when the player lets them", async () => {
    const { session, events } = start();
    await offered();
    await session.joinVoice();
    const roster = (mutedByPlayer: boolean) => ({
      type: "crew",
      watchId: "w1",
      data: {
        kind: "roster",
        people: [
          { id: "player", name: null, mid: "2", inVoice: true, muted: false, mutedByPlayer: false },
          { id: "w1", name: "Lea", mid: null, inVoice: true, muted: false, mutedByPlayer },
        ],
      },
    });
    socket().deliver(roster(true));
    expect(mic.enabled).toBe(false);
    expect(session.voice().mutedByPlayer).toBe(true);
    expect(events.filter((e) => e.type === "voice").at(-1)).toMatchObject({ voice: { mutedByPlayer: true } });
    socket().deliver(roster(false));
    expect(mic.enabled).toBe(true);
  });

  it("mutes a person for this viewer alone, by who the roster says is on each line", async () => {
    const { session } = start();
    await offered();
    socket().deliver({
      type: "crew",
      watchId: "w1",
      data: {
        kind: "roster",
        people: [
          { id: "player", name: null, mid: "2", inVoice: true, muted: false, mutedByPlayer: false },
          { id: "w2", name: "Jon", mid: "3", inVoice: true, muted: false, mutedByPlayer: false },
          { id: "w1", name: "Lea", mid: null, inVoice: false, muted: false, mutedByPlayer: false },
        ],
      },
    });
    const line = (mid: string) => document.querySelector<HTMLAudioElement>(`audio[data-voice-mid="${mid}"]`)!;
    expect(line("3").dataset.person).toBe("w2");
    session.muteForMe("w2", true);
    expect(line("3").muted).toBe(true);
    expect(line("2").muted).toBe(false);
    session.muteForMe("w2", false);
    expect(line("3").muted).toBe(false);
  });

  it("ends when the watch is over, and says why", async () => {
    const { events } = start();
    await offered();
    socket().deliver({ type: "denied", reason: "watch-stopped" });
    expect(events.filter((e) => e.type === "denied" || e.type === "ended")).toEqual([
      { type: "denied", reason: "watch-stopped" },
      { type: "ended", reason: "denied" },
    ]);
    expect(peer().closed).toBe(true);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });
});
