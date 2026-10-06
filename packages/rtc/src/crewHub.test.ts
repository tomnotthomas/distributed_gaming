// The player's crew hub against fake connections: what each viewer's
// connection carries, that none ever has a data channel (no input, ever),
// that nothing is sent on before the game is on screen, that the microphone is
// asked for only on joining the voice chat, and that voices are passed on and
// silenced as the player says.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCrewHub, VIEWER_MAX_BITRATE, VOICE_SLOTS, type CrewHubOptions } from "./crewHub";
import type { SignalMessage } from "./signaling";
import { FakeMediaPeer, FakeMediaStream, FakeTrack } from "./test/media";

type Watchers = Extract<SignalMessage, { type: "watchers" }>;

const watcher = (watchId: string, state: "asking" | "watching" = "watching", here = true) => ({
  watchId,
  name: watchId.toUpperCase(),
  state,
  here,
});
const watchers = (...list: ReturnType<typeof watcher>[]): Watchers => ({
  type: "watchers",
  sharing: false,
  watchers: list,
});
const flush = () => vi.advanceTimersByTimeAsync(0);

let sent: SignalMessage[];
let mic: FakeTrack;
let getMicrophone: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeMediaPeer.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakeMediaPeer);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  HTMLMediaElement.prototype.play = vi.fn(async () => {}) as unknown as HTMLMediaElement["play"];
  sent = [];
  mic = new FakeTrack("audio");
  getMicrophone = vi.fn(async () => new FakeMediaStream([mic]));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hub(opts: CrewHubOptions = {}) {
  const crew = startCrewHub({
    getMicrophone: getMicrophone as unknown as () => Promise<MediaStream>,
    ...opts,
  });
  crew.attach((msg) => sent.push(msg));
  return crew;
}

const peerFor = (index: number) => FakeMediaPeer.instances[index]!;
const ofType = <T extends SignalMessage["type"]>(type: T) =>
  sent.filter((m): m is Extract<SignalMessage, { type: T }> => m.type === type);
const rosterFor = (watchId: string) => {
  const crew = ofType("crew").filter((m) => m.watchId === watchId);
  const last = crew[crew.length - 1];
  return last?.data.kind === "roster" ? last.data.people : null;
};

describe("startCrewHub", () => {
  it("offers a viewer the picture, the game, a voice line and voice slots, and no data channel at all", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea")));
    await flush();

    expect(FakeMediaPeer.instances).toHaveLength(1);
    const pc = peerFor(0);
    expect(pc.dataChannels).toEqual([]);
    expect(pc.transceivers.map((t) => [t.kind, t.direction])).toEqual([
      ["video", "sendonly"],
      ["audio", "sendonly"],
      ["audio", "sendrecv"],
      ...Array.from({ length: VOICE_SLOTS }, () => ["audio", "sendonly"]),
    ]);
    expect(pc.transceivers[0]!.sendEncodings[0]!.maxBitrate).toBe(VIEWER_MAX_BITRATE);
    expect(ofType("offer")).toEqual([{ type: "offer", sdp: pc.localDescription, watchId: "lea" }]);
  });

  it("connects nobody still asking or away, and hangs up on a viewer no longer watching", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea", "asking"), watcher("jon", "watching", false)));
    await flush();
    expect(FakeMediaPeer.instances).toHaveLength(0);

    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    expect(FakeMediaPeer.instances).toHaveLength(2);
    crew.message(watchers(watcher("jon")));
    await flush();
    expect(peerFor(0).closed).toBe(true);
    expect(peerFor(1).closed).toBe(false);
    expect(crew.state().watchers.map((w) => w.watchId)).toEqual(["jon"]);
  });

  it("sends a viewer nothing of the PC's until the game is on screen", async () => {
    const crew = hub();
    const picture = new FakeTrack("video");
    const sound = new FakeTrack("audio");
    crew.source(picture as unknown as MediaStreamTrack);
    crew.source(sound as unknown as MediaStreamTrack);
    crew.message(watchers(watcher("lea")));
    await flush();
    expect(peerFor(0).sending().slice(0, 2)).toEqual([null, null]);

    crew.setLive(true);
    await flush();
    expect(peerFor(0).sending().slice(0, 2)).toEqual([picture.id, sound.id]);

    // Back behind Ignition (the PC left): the viewer sees nothing until the game is back.
    crew.setLive(false);
    await flush();
    expect(peerFor(0).sending().slice(0, 2)).toEqual([null, null]);
  });

  it("passes on a new picture from the PC to every viewer, without a new offer", async () => {
    const crew = hub();
    crew.setLive(true);
    crew.message(watchers(watcher("lea")));
    await flush();
    const next = new FakeTrack("video");
    crew.source(next as unknown as MediaStreamTrack);
    await flush();
    expect(peerFor(0).sending()[0]).toBe(next.id);
    expect(ofType("offer")).toHaveLength(1);
  });

  it("asks for the microphone only when the player joins the voice chat, and lets it go on leaving", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea")));
    await flush();
    expect(getMicrophone).not.toHaveBeenCalled();
    expect(peerFor(0).sending()[2]).toBeNull();

    await crew.joinVoice();
    await flush();
    expect(getMicrophone).toHaveBeenCalledTimes(1);
    expect(peerFor(0).sending()[2]).toBe(mic.id);
    expect(rosterFor("lea")?.[0]).toMatchObject({ id: "player", inVoice: true, mid: "2" });

    crew.leaveVoice();
    await flush();
    expect(peerFor(0).sending()[2]).toBeNull();
    expect(mic.stopped).toBe(true);
  });

  it("says so when the microphone is refused, and stays out of the voice chat", async () => {
    getMicrophone.mockRejectedValueOnce(new Error("NotAllowedError"));
    const crew = hub();
    await crew.joinVoice();
    expect(crew.state().voice).toMatchObject({ inVoice: false, micRefused: true });
  });

  it("talks on push to talk only while it is held, and never while muted", async () => {
    const crew = hub();
    await crew.joinVoice();
    expect(mic.enabled).toBe(true);
    crew.setMode("push");
    expect(mic.enabled).toBe(false);
    crew.setTalking(true);
    expect(mic.enabled).toBe(true);
    crew.setMuted(true);
    expect(mic.enabled).toBe(false);
    crew.setMuted(false);
    crew.setTalking(false);
    expect(mic.enabled).toBe(false);
    crew.setMode("open");
    expect(mic.enabled).toBe(true);
  });

  it("passes each viewer's voice on to the others, and names who is on which line", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    const [lea, jon] = [peerFor(0), peerFor(1)];
    const leaVoice = lea.arrive(2);
    const jonVoice = jon.arrive(2);
    await flush();
    // Each hears the other on their first slot, and nobody hears themselves.
    expect(jon.sending()[3]).toBe(leaVoice.id);
    expect(lea.sending()[3]).toBe(jonVoice.id);
    expect(lea.sending().slice(4)).toEqual([null, null]);
    expect(rosterFor("jon")).toEqual([
      { id: "player", name: null, mid: "2", inVoice: false, muted: false, mutedByPlayer: false },
      { id: "lea", name: "LEA", mid: "3", inVoice: false, muted: false, mutedByPlayer: false },
      { id: "jon", name: "JON", mid: null, inVoice: false, muted: false, mutedByPlayer: false },
    ]);
    // The player hears both, each on a line of their own.
    expect([...document.querySelectorAll("audio")].map((a) => (a as HTMLAudioElement).dataset.voice)).toEqual(
      ["lea", "jon"],
    );
  });

  it("keeps one player for a viewer's voice when their track arrives again, so muting them reaches it", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea")));
    await flush();
    const lea = peerFor(0);
    lea.arrive(2);
    lea.arrive(2);
    await flush();
    const players = document.querySelectorAll<HTMLAudioElement>('audio[data-voice="lea"]');
    expect(players).toHaveLength(1);
    crew.muteForMe("lea", true);
    await flush();
    expect(players[0]!.muted).toBe(true);
  });

  it("follows what a viewer says of their voice, from that viewer alone", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    crew.message({ type: "crew", watchId: "lea", data: { kind: "voice", inVoice: true, muted: true } });
    expect(crew.state().watchers.find((w) => w.watchId === "lea")).toMatchObject({
      inVoice: true,
      muted: true,
    });
    expect(rosterFor("jon")?.[1]).toMatchObject({ id: "lea", inVoice: true, muted: true });
  });

  it("mutes a viewer for everyone when the player says so, and for the player alone when they choose", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    const [lea, jon] = [peerFor(0), peerFor(1)];
    const leaVoice = lea.arrive(2);
    await flush();
    const leaAudio = document.querySelector<HTMLAudioElement>('audio[data-voice="lea"]')!;

    crew.muteForMe("lea", true);
    await flush();
    expect(leaAudio.muted).toBe(true);
    expect(jon.sending()[3]).toBe(leaVoice.id);

    crew.muteForMe("lea", false);
    crew.muteForAll("lea", true);
    await flush();
    expect(leaAudio.muted).toBe(true);
    expect(jon.sending()[3]).toBeNull();
    expect(rosterFor("lea")?.at(-1)).toMatchObject({ id: "lea", mutedByPlayer: true });
    expect(crew.state().watchers[0]).toMatchObject({ mutedByPlayer: true });

    crew.muteForAll("lea", false);
    await flush();
    expect(jon.sending()[3]).toBe(leaVoice.id);
    expect(leaAudio.muted).toBe(false);
  });

  it("applies a viewer's answer and candidates to that viewer's connection alone", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    crew.message({ type: "answer", sdp: { type: "answer", sdp: "v=0 lea" }, watchId: "lea" });
    await flush();
    crew.message({ type: "ice", candidate: { candidate: "candidate:lea" }, watchId: "lea" });
    crew.message({ type: "ice", candidate: { candidate: "candidate:nobody" }, watchId: "nobody" });
    await flush();
    expect(peerFor(0).remoteDescription).toEqual({ type: "answer", sdp: "v=0 lea" });
    expect(peerFor(0).candidates).toEqual([{ candidate: "candidate:lea" }]);
    expect(peerFor(1).remoteDescription).toBeNull();
    expect(peerFor(1).candidates).toEqual([]);
  });

  it("says the player's yes, no, stop and share to the server", () => {
    const crew = hub();
    crew.answer("lea", true);
    crew.answer("jon", false);
    crew.stop("lea");
    crew.share(true);
    expect(sent).toEqual([
      { type: "watch-answer", watchId: "lea", accept: true },
      { type: "watch-answer", watchId: "jon", accept: false },
      { type: "watch-stop", watchId: "lea" },
      { type: "watch-share", open: true },
    ]);
  });

  it("connects a viewer again when their connection fails while they are here", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea")));
    await flush();
    peerFor(0).setState("failed");
    await flush();
    expect(peerFor(0).closed).toBe(true);
    expect(FakeMediaPeer.instances).toHaveLength(2);
    expect(crew.state().watchers[0]!.connected).toBe(false);
    peerFor(1).setState("connected");
    expect(crew.state().watchers[0]!.connected).toBe(true);
  });

  it("hangs up on everyone and lets the microphone go when it ends", async () => {
    const crew = hub();
    crew.message(watchers(watcher("lea")));
    await crew.joinVoice();
    await flush();
    crew.end();
    expect(peerFor(0).closed).toBe(true);
    expect(mic.stopped).toBe(true);
    crew.message(watchers(watcher("lea"), watcher("jon")));
    await flush();
    expect(FakeMediaPeer.instances).toHaveLength(1);
  });
});
