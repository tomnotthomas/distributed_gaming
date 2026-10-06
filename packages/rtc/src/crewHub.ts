// The player's side of watching and the crew's voice chat.
//
//   watchers ──► a viewer watching ──► one peer connection to them, made here
//                                        ├─ video      the game's picture, as received from the PC, re-encoded
//                                        ├─ game       the game's sound, as received
//                                        ├─ voice      the player's microphone out, the viewer's in
//                                        └─ slots ×3   each other viewer's voice, passed on
//
// The player's page is the hub: it receives the PC's stream once and streams
// it on to each crewmate watching, so the gaming PC uploads one stream however
// many watch, and it never hears of a viewer at all. A viewer's connection is
// made with no data channel: there is no way for a viewer's input to reach the
// game, by construction.
//
// Everyone's voice goes through the hub too: each viewer sends theirs on the
// voice transceiver, and the hub passes it on in a slot of every other
// viewer's connection. Every transceiver is there from the first offer, so
// joining and leaving the voice chat, muting, and viewers coming and going
// only swap tracks (replaceTrack) and never negotiate again. Nothing is
// recorded: the server only introduces the two pages.
//
// The viewer sees the game, never the PC's desktop: until the player's own
// stream shows the game (`setLive`), nothing is sent on.

import { createIceInbox, type IceInbox } from "./iceInbox";
import { createPeerConnection, DEFAULT_ICE_SERVERS, type IceConfig } from "./peer";
import type { SignalMessage } from "./signaling";
import { MAX_WATCHERS, type CrewSignal, type VoicePerson, type Watcher } from "../../../server/src/protocol";

/** What a viewer's copy of the picture may take: 720p-ish at 30 fps, so watching costs the player's link little. */
export const VIEWER_MAX_BITRATE = 2_500_000;
export const VIEWER_MAX_FRAMERATE = 30;
/** The other viewers' voices each viewer can hear: everyone else a session can take. */
export const VOICE_SLOTS = MAX_WATCHERS - 1;

/** How a person talks: always while not muted (open mic), or only while holding the talk key or button. */
export type MicMode = "open" | "push";

/** The player's own place in the voice chat. */
export type MyVoice = {
  inVoice: boolean;
  muted: boolean;
  mode: MicMode;
  /** Holding push to talk. */
  talking: boolean;
  /** The microphone could not be had (refused, or none): not in the voice chat. */
  micRefused: boolean;
};

/** A viewer as the player's page shows them. */
export type WatcherView = Watcher & {
  /** Their connection is up. */
  connected: boolean;
  inVoice: boolean;
  muted: boolean;
  /** Muted for everyone, by the player. */
  mutedByPlayer: boolean;
  /** Muted for the player alone. */
  mutedForMe: boolean;
};

export type CrewHubState = {
  sharing: boolean;
  watchers: WatcherView[];
  voice: MyVoice;
};

export type CrewHubOptions = IceConfig & {
  /** Every change of the state. */
  onChange?: (state: CrewHubState) => void;
  /** Where viewers' voices are played, hidden. Defaults to the document's body. */
  audioHost?: HTMLElement;
  /** The player's microphone, asked for only when they join the voice chat. */
  getMicrophone?: () => Promise<MediaStream>;
};

export type CrewHub = {
  /** The renter session's socket is in the room: say things through `send`. */
  attach(send: (msg: SignalMessage) => void): void;
  /** A message the renter session passes on: `watchers`, and what a viewer sends (named by `watchId`). */
  message(msg: SignalMessage): void;
  /** A track the PC sent: the picture or the game's sound, passed on to every viewer. */
  source(track: MediaStreamTrack): void;
  /** Whether the player's stream shows the game: only then is anything passed on. */
  setLive(live: boolean): void;
  /** Let a viewer asking watch, or turn them down. */
  answer(watchId: string, accept: boolean): void;
  /** Stop a viewer watching. */
  stop(watchId: string): void;
  /** Open the screen to the crew, or close it again. */
  share(open: boolean): void;
  /** Join the voice chat: asks for the microphone now, and only now. */
  joinVoice(): Promise<void>;
  leaveVoice(): void;
  setMuted(muted: boolean): void;
  setMode(mode: MicMode): void;
  /** Push to talk held (true) or let go. */
  setTalking(talking: boolean): void;
  /** Hear a viewer, or not, on this page alone. */
  muteForMe(watchId: string, muted: boolean): void;
  /** Mute a viewer for everyone, or let them speak again. */
  muteForAll(watchId: string, muted: boolean): void;
  state(): CrewHubState;
  /** Hang up on every viewer and leave the voice chat. Idempotent. */
  end(): void;
};

/** One viewer's connection. */
type Link = {
  watchId: string;
  pc: RTCPeerConnection;
  inbox: IceInbox;
  video: RTCRtpTransceiver;
  game: RTCRtpTransceiver;
  voice: RTCRtpTransceiver;
  slots: RTCRtpTransceiver[];
  /** The viewer's voice, as it arrives. */
  incoming: MediaStreamTrack | null;
  audio: HTMLAudioElement | null;
  connected: boolean;
  /** In the voice chat, and muted, as the viewer says. */
  inVoice: boolean;
  muted: boolean;
};

export function startCrewHub(opts: CrewHubOptions = {}): CrewHub {
  let send: ((msg: SignalMessage) => void) | null = null;
  let serverIce: RTCIceServer[] = [];
  let watchers: Watcher[] = [];
  let sharing = false;
  let live = false;
  let ended = false;
  const sources: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null } = {
    video: null,
    audio: null,
  };
  const links = new Map<string, Link>();
  /** Viewers muted for everyone by the player, and for the player alone: kept while they reconnect. */
  const silenced = new Set<string>();
  const hushed = new Set<string>();
  let mic: MediaStream | null = null;
  const voice: MyVoice = { inVoice: false, muted: false, mode: "open", talking: false, micRefused: false };
  const getMicrophone =
    opts.getMicrophone ??
    (() =>
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }));

  const state = (): CrewHubState => ({
    sharing,
    voice: { ...voice },
    watchers: watchers.map((w) => {
      const link = links.get(w.watchId);
      return {
        ...w,
        connected: link?.connected ?? false,
        inVoice: link?.inVoice ?? false,
        muted: link?.muted ?? false,
        mutedByPlayer: silenced.has(w.watchId),
        mutedForMe: hushed.has(w.watchId),
      };
    }),
  });
  const changed = () => opts.onChange?.(state());

  const say = (msg: SignalMessage) => send?.(msg);

  /** The player's microphone track, sending only while they mean it to. */
  const micTrack = () => mic?.getAudioTracks()[0] ?? null;
  const applyMic = () => {
    const track = micTrack();
    if (track) track.enabled = !voice.muted && (voice.mode === "open" || voice.talking);
  };

  /** Everything each viewer's connection carries, as things stand now. */
  const wire = () => {
    const order = watchers.filter((w) => links.has(w.watchId)).map((w) => links.get(w.watchId)!);
    for (const link of order) {
      void replace(link.video, live ? sources.video : null);
      void replace(link.game, live ? sources.audio : null);
      void replace(link.voice, voice.inVoice ? micTrack() : null);
      const others = order.filter((o) => o !== link);
      link.slots.forEach((slot, i) => {
        const other = others[i];
        const passOn = other && !silenced.has(other.watchId) ? other.incoming : null;
        void replace(slot, passOn);
      });
    }
    for (const link of order) {
      if (link.audio) link.audio.muted = hushed.has(link.watchId) || silenced.has(link.watchId);
    }
    roster();
  };

  /** Tell each viewer who is in the voice chat, and which of their transceivers carries whom. */
  const roster = () => {
    const order = watchers.filter((w) => links.has(w.watchId)).map((w) => links.get(w.watchId)!);
    const person = (link: Link, mid: string | null): VoicePerson => ({
      id: link.watchId,
      name: watchers.find((w) => w.watchId === link.watchId)?.name ?? null,
      mid,
      inVoice: link.inVoice,
      muted: link.muted,
      mutedByPlayer: silenced.has(link.watchId),
    });
    for (const link of order) {
      const others = order.filter((o) => o !== link);
      const people: VoicePerson[] = [
        {
          id: "player",
          name: null,
          mid: link.voice.mid,
          inVoice: voice.inVoice,
          muted: voice.muted,
          mutedByPlayer: false,
        },
        ...others.slice(0, link.slots.length).map((o, i) => person(o, link.slots[i]!.mid)),
        person(link, null),
      ];
      const data: CrewSignal = { kind: "roster", people };
      say({ type: "crew", watchId: link.watchId, data });
    }
  };

  /** Hang up on one viewer. */
  const drop = (watchId: string) => {
    const link = links.get(watchId);
    if (!link) return;
    links.delete(watchId);
    link.audio?.remove();
    link.pc.close();
  };

  /** A connection to a viewer now watching, offered to them. */
  const connect = async (watchId: string) => {
    const pc = createPeerConnection({
      ...opts,
      iceServers: opts.iceServers ?? [...DEFAULT_ICE_SERVERS, ...serverIce],
    });
    const video = pc.addTransceiver("video", {
      direction: "sendonly",
      sendEncodings: [{ maxBitrate: VIEWER_MAX_BITRATE, maxFramerate: VIEWER_MAX_FRAMERATE }],
    });
    const game = pc.addTransceiver("audio", { direction: "sendonly" });
    const voiceLine = pc.addTransceiver("audio", { direction: "sendrecv" });
    const slots = Array.from({ length: VOICE_SLOTS }, () =>
      pc.addTransceiver("audio", { direction: "sendonly" }),
    );
    const link: Link = {
      watchId,
      pc,
      inbox: createIceInbox(pc),
      video,
      game,
      voice: voiceLine,
      slots,
      incoming: null,
      audio: null,
      connected: false,
      inVoice: false,
      muted: false,
    };
    links.set(watchId, link);

    pc.onicecandidate = (event) => {
      if (event.candidate && links.get(watchId) === link) {
        say({ type: "ice", candidate: event.candidate.toJSON(), watchId });
      }
    };
    pc.addEventListener("connectionstatechange", () => {
      if (links.get(watchId) !== link) return;
      link.connected = pc.connectionState === "connected";
      // A connection that failed is made again while the viewer is here.
      if (pc.connectionState === "failed") {
        drop(watchId);
        reconcile();
      }
      changed();
    });
    pc.ontrack = (event) => {
      if (event.transceiver !== voiceLine || links.get(watchId) !== link) return;
      link.incoming = event.track;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.hidden = true;
      audio.dataset.voice = watchId;
      audio.srcObject = new MediaStream([event.track]);
      link.audio = audio;
      (opts.audioHost ?? document.body).append(audio);
      void audio.play?.()?.catch(() => {});
      wire();
    };

    wire();
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch {
      if (links.get(watchId) === link) drop(watchId);
      return;
    }
    if (links.get(watchId) !== link) return;
    say({ type: "offer", sdp: pc.localDescription!, watchId });
    // The roster names transceivers by mid, which the offer just set.
    wire();
  };

  /** Make the connections the watchers call for, and drop the rest. */
  const reconcile = () => {
    if (ended) return;
    const watching = new Set(watchers.filter((w) => w.state === "watching").map((w) => w.watchId));
    for (const watchId of [...links.keys()]) if (!watching.has(watchId)) drop(watchId);
    for (const w of watchers) {
      if (w.state === "watching" && w.here && !links.has(w.watchId) && send) void connect(w.watchId);
    }
    for (const watchId of [...silenced])
      if (!watchers.some((w) => w.watchId === watchId)) silenced.delete(watchId);
    for (const watchId of [...hushed])
      if (!watchers.some((w) => w.watchId === watchId)) hushed.delete(watchId);
    wire();
    changed();
  };

  const fromViewer = (msg: SignalMessage) => {
    if (!("watchId" in msg) || typeof msg.watchId !== "string") return;
    const link = links.get(msg.watchId);
    if (!link) return;
    if (msg.type === "answer" && msg.sdp) {
      void link.inbox.setRemote(msg.sdp).catch(() => {
        console.warn("[swiff] could not apply a viewer's answer");
      });
    } else if (msg.type === "ice" && msg.candidate) link.inbox.add(msg.candidate);
    else if (msg.type === "crew" && msg.data?.kind === "voice") {
      link.inVoice = msg.data.inVoice === true;
      link.muted = msg.data.muted === true;
      wire();
      changed();
    }
  };

  return {
    attach(next) {
      send = next;
      reconcile();
    },
    message(msg) {
      if (ended) return;
      if (msg.type === "watchers") {
        watchers = Array.isArray(msg.watchers) ? msg.watchers : [];
        sharing = msg.sharing === true;
        reconcile();
      } else if (msg.type === "joined") {
        serverIce = msg.iceServers ?? [];
      } else fromViewer(msg);
    },
    source(track) {
      if (track.kind === "video") sources.video = track;
      else if (track.kind === "audio") sources.audio = track;
      wire();
    },
    setLive(next) {
      if (live === next) return;
      live = next;
      wire();
    },
    answer(watchId, accept) {
      say({ type: "watch-answer", watchId, accept });
    },
    stop(watchId) {
      say({ type: "watch-stop", watchId });
    },
    share(open) {
      say({ type: "watch-share", open });
    },
    async joinVoice() {
      if (voice.inVoice || ended) return;
      try {
        mic = await getMicrophone();
      } catch {
        voice.micRefused = true;
        changed();
        return;
      }
      if (ended) {
        mic.getTracks().forEach((t) => t.stop());
        mic = null;
        return;
      }
      voice.inVoice = true;
      voice.micRefused = false;
      applyMic();
      wire();
      changed();
    },
    leaveVoice() {
      if (!voice.inVoice) return;
      voice.inVoice = false;
      mic?.getTracks().forEach((t) => t.stop());
      mic = null;
      wire();
      changed();
    },
    setMuted(muted) {
      voice.muted = muted;
      applyMic();
      roster();
      changed();
    },
    setMode(mode) {
      voice.mode = mode;
      voice.talking = false;
      applyMic();
      changed();
    },
    setTalking(talking) {
      if (voice.talking === talking) return;
      voice.talking = talking;
      applyMic();
      changed();
    },
    muteForMe(watchId, muted) {
      if (muted) hushed.add(watchId);
      else hushed.delete(watchId);
      wire();
      changed();
    },
    muteForAll(watchId, muted) {
      if (muted) silenced.add(watchId);
      else silenced.delete(watchId);
      wire();
      changed();
    },
    state,
    end() {
      if (ended) return;
      ended = true;
      for (const watchId of [...links.keys()]) drop(watchId);
      mic?.getTracks().forEach((t) => t.stop());
      mic = null;
      send = null;
    },
  };
}

/** Swap the track a transceiver sends, when it changed. A closed connection refuses: nothing to do then. */
async function replace(transceiver: RTCRtpTransceiver, track: MediaStreamTrack | null): Promise<void> {
  if (transceiver.sender.track === track) return;
  await transceiver.sender.replaceTrack(track).catch(() => {});
}
