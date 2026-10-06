// A viewer's side of watching a crewmate play: view only, and the voice chat.
//
//   watch(ticket) ──► watching: asking ──► (the player says yes) ──► watching ──► offer ──► answer
//                                                                                  ├─ video + game sound ──► <video>
//                                                                                  └─ voices ──► one <audio> each
//
// The player's page makes the connection and sends the picture, the game's
// sound and the crew's voices on it (crewHub.ts). This side only answers. It
// sends nothing to the game: it never makes or accepts a data channel, and it
// never reads the keyboard, mouse or controller for anyone but the voice
// chat's push to talk. What it sends the player is its own voice, and only
// once the viewer joins the voice chat, which is also the only time it asks
// for the microphone.

import { createIceInbox, type IceInbox } from "./iceInbox";
import { createPeerConnection, DEFAULT_ICE_SERVERS, type IceConfig } from "./peer";
import { readRenterStats, DEFAULT_STATS_INTERVAL_MS, type RenterStats } from "./renterSession";
import { connectSignaling, type SignalMessage } from "./signaling";
import type { CrewSignal, VoicePerson } from "../../../server/src/protocol";
import type { MicMode, MyVoice } from "./crewHub";

type DeniedReason = Extract<SignalMessage, { type: "denied" }>["reason"];

/** A viewer's own place in the voice chat: as the player's, and whether the player muted them. */
export type ViewerVoice = MyVoice & { mutedByPlayer: boolean };

export type WatchSessionEvent =
  /** Where the watch stands: still `asking`, or `watching`; and whether the player's page is there. */
  | { type: "watching"; state: "asking" | "watching"; player: string | null; playerHere: boolean }
  /** A connection from the player, or null once it is gone. */
  | { type: "peer-connection"; pc: RTCPeerConnection | null }
  | { type: "connected" }
  | { type: "disconnected"; failed: boolean }
  /** The first frame of the player's picture. */
  | { type: "first-frame" }
  /** The browser refused sound, so the picture plays muted. */
  | { type: "autoplay-muted" }
  /** Who is in the voice chat, from the player. */
  | { type: "roster"; people: VoicePerson[] }
  /** This viewer's own place in the voice chat changed. */
  | { type: "voice"; voice: ViewerVoice }
  | { type: "stats"; stats: RenterStats }
  /** The watch is over: the player said no or stopped it, the session ended, or the ticket was refused. */
  | { type: "denied"; reason: DeniedReason }
  | { type: "ended"; reason: "local" | "denied" };

export type WatchSessionOptions = IceConfig & {
  url: string;
  /** The watch ticket POST /api/crew-live/:id/watch gave. */
  ticket: string;
  /** Plays the player's picture and the game's sound. */
  video?: HTMLVideoElement;
  /** Where voices are played, hidden. Defaults to the document's body. */
  audioHost?: HTMLElement;
  /** The viewer's microphone, asked for only when they join the voice chat. */
  getMicrophone?: () => Promise<MediaStream>;
  statsIntervalMs?: number;
};

export type WatchSession = {
  on(listener: (event: WatchSessionEvent) => void): () => void;
  /** Join the voice chat: asks for the microphone now, and only now. */
  joinVoice(): Promise<void>;
  leaveVoice(): void;
  setMuted(muted: boolean): void;
  setMode(mode: MicMode): void;
  /** Push to talk held (true) or let go. */
  setTalking(talking: boolean): void;
  /** Hear someone, or not, on this page alone. `id` as the roster names them. */
  muteForMe(id: string, muted: boolean): void;
  /** The latest roster. */
  roster(): VoicePerson[];
  voice(): ViewerVoice;
  /** Leave: hang up and close the socket. Idempotent. */
  end(): void;
};

/**
 * Take a viewer seat with a watch ticket and play what the player streams.
 * Everything that happens is reported as an event.
 */
export function startWatchSession(opts: WatchSessionOptions): WatchSession {
  const listeners = new Set<(event: WatchSessionEvent) => void>();
  const emit = (event: WatchSessionEvent) => listeners.forEach((fn) => fn(event));
  const statsIntervalMs = opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
  const getMicrophone =
    opts.getMicrophone ??
    (() =>
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }));

  let pc: RTCPeerConnection | null = null;
  let inbox: IceInbox | null = null;
  let voiceLine: RTCRtpTransceiver | null = null;
  let serverIce: RTCIceServer[] = [];
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  let detach: AbortController | null = null;
  let people: VoicePerson[] = [];
  let mutedByPlayer = false;
  let mic: MediaStream | null = null;
  let ended = false;
  let send: ((msg: SignalMessage) => void) | null = null;
  const voice: MyVoice = { inVoice: false, muted: false, mode: "open", talking: false, micRefused: false };
  /** Voices played, by the mid of the transceiver that carries them. */
  const voices = new Map<string, HTMLAudioElement>();
  const hushed = new Set<string>();

  const micTrack = () => mic?.getAudioTracks()[0] ?? null;
  const applyMic = () => {
    const track = micTrack();
    if (track) {
      track.enabled = !voice.muted && !mutedByPlayer && (voice.mode === "open" || voice.talking);
    }
  };
  /** Tell the player where this viewer's voice stands. */
  const tellVoice = () => {
    const data: CrewSignal = { kind: "voice", inVoice: voice.inVoice, muted: voice.muted };
    send?.({ type: "crew", data });
  };
  const voiceChanged = () => {
    applyMic();
    emit({ type: "voice", voice: { ...voice, mutedByPlayer } });
  };

  /** Mute or unmute each voice by who it is now, as this viewer chose. */
  const applyHushed = () => {
    for (const [mid, audio] of voices) {
      const who = people.find((p) => p.mid === mid);
      audio.muted = who ? hushed.has(who.id) || who.mutedByPlayer : false;
      if (who) audio.dataset.person = who.id;
    }
  };

  const teardown = () => {
    clearInterval(statsTimer);
    detach?.abort();
    detach = null;
    for (const audio of voices.values()) audio.remove();
    voices.clear();
    voiceLine = null;
    if (!pc) return;
    pc.close();
    pc = null;
    inbox = null;
    emit({ type: "peer-connection", pc: null });
  };

  const answer = async (sdp: RTCSessionDescriptionInit, reply: (m: SignalMessage) => void) => {
    teardown();
    const connection = createPeerConnection({
      ...opts,
      iceServers: opts.iceServers ?? [...DEFAULT_ICE_SERVERS, ...serverIce],
    });
    const signal = (detach = new AbortController()).signal;
    pc = connection;
    inbox = createIceInbox(connection);
    emit({ type: "peer-connection", pc: connection });

    connection.onicecandidate = (event) => {
      if (event.candidate) reply({ type: "ice", candidate: event.candidate.toJSON() });
    };
    // A viewer takes no data channel: nothing it could send would ever be input.
    connection.ondatachannel = ({ channel }) => channel.close();
    connection.addEventListener(
      "connectionstatechange",
      () => {
        const state = connection.connectionState;
        if (state === "connected") emit({ type: "connected" });
        if (state === "disconnected" || state === "failed") {
          emit({ type: "disconnected", failed: state === "failed" });
        }
      },
      { signal },
    );

    let sawFrame = false;
    const firstFrame = () => {
      if (sawFrame || pc !== connection) return;
      sawFrame = true;
      emit({ type: "first-frame" });
    };

    try {
      await inbox.setRemote(sdp);
    } catch {
      if (pc === connection) console.warn("[swiff] could not take the player's offer");
      return;
    }
    if (pc !== connection) return;
    // The player's transceivers, in the order it made them: the picture, the
    // game's sound, the voice line both ways, then the other viewers' voices.
    const [video, game, line, ...slots] = connection.getTransceivers();
    if (!video || !game || !line) return;
    voiceLine = line;
    line.direction = "sendrecv";
    if (voice.inVoice) await line.sender.replaceTrack(micTrack()).catch(() => {});

    const picture = new MediaStream([video.receiver.track, game.receiver.track]);
    const element = opts.video;
    if (element) {
      element.srcObject = picture;
      element.addEventListener("loadeddata", firstFrame, { once: true, signal });
      void element.play().catch(() => {
        element.muted = true;
        emit({ type: "autoplay-muted" });
        return element.play().catch(() => {});
      });
    }
    for (const transceiver of [line, ...slots]) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.hidden = true;
      audio.dataset.voiceMid = transceiver.mid ?? "";
      audio.srcObject = new MediaStream([transceiver.receiver.track]);
      (opts.audioHost ?? document.body).append(audio);
      void audio.play?.()?.catch(() => {});
      if (transceiver.mid) voices.set(transceiver.mid, audio);
    }
    applyHushed();

    let previous: ReturnType<typeof readRenterStats>["sample"] = null;
    statsTimer = setInterval(() => {
      void connection.getStats().then(
        (report) => {
          if (pc !== connection) return;
          const reading = readRenterStats(report, previous);
          previous = reading.sample;
          emit({ type: "stats", stats: reading.stats });
          if (reading.stats.framesDecoded > 0) firstFrame();
        },
        () => {},
      );
    }, statsIntervalMs);

    try {
      const local = await connection.createAnswer();
      await connection.setLocalDescription(local);
      if (pc !== connection) return;
      reply({ type: "answer", sdp: connection.localDescription ?? local });
      tellVoice();
    } catch {
      if (pc === connection) console.warn("[swiff] could not answer the player's offer");
    }
  };

  const signaling = connectSignaling({
    url: opts.url,
    onOpen: (next) => {
      send = next;
      next({ type: "watch", ticket: opts.ticket });
    },
    onMessage: (msg, reply) => {
      send = reply;
      switch (msg.type) {
        case "watching":
          serverIce = msg.iceServers ?? [];
          emit({ type: "watching", state: msg.state, player: msg.player, playerHere: msg.playerHere });
          break;
        case "offer":
          if (msg.sdp) void answer(msg.sdp, reply);
          break;
        case "ice":
          if (msg.candidate) inbox?.add(msg.candidate);
          break;
        case "crew":
          if (msg.data?.kind === "roster" && Array.isArray(msg.data.people)) {
            people = msg.data.people;
            const me = people.find((p) => p.mid === null);
            const was = mutedByPlayer;
            mutedByPlayer = me?.mutedByPlayer === true;
            applyHushed();
            if (was !== mutedByPlayer) voiceChanged();
            emit({ type: "roster", people });
          }
          break;
        case "denied":
          emit({ type: "denied", reason: msg.reason });
          finish("denied");
          break;
      }
    },
  });

  function finish(reason: "local" | "denied") {
    if (ended) return;
    ended = true;
    signaling.close();
    teardown();
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
    emit({ type: "ended", reason });
    listeners.clear();
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async joinVoice() {
      if (voice.inVoice || ended) return;
      try {
        mic = await getMicrophone();
      } catch {
        voice.micRefused = true;
        voiceChanged();
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
      await voiceLine?.sender.replaceTrack(micTrack()).catch(() => {});
      tellVoice();
      voiceChanged();
    },
    leaveVoice() {
      if (!voice.inVoice) return;
      voice.inVoice = false;
      void voiceLine?.sender.replaceTrack(null).catch(() => {});
      mic?.getTracks().forEach((t) => t.stop());
      mic = null;
      tellVoice();
      voiceChanged();
    },
    setMuted(muted) {
      voice.muted = muted;
      tellVoice();
      voiceChanged();
    },
    setMode(mode) {
      voice.mode = mode;
      voice.talking = false;
      voiceChanged();
    },
    setTalking(talking) {
      if (voice.talking === talking) return;
      voice.talking = talking;
      voiceChanged();
    },
    muteForMe(id, muted) {
      if (muted) hushed.add(id);
      else hushed.delete(id);
      applyHushed();
    },
    roster: () => people,
    voice: () => ({ ...voice, mutedByPlayer }),
    end: () => finish("local"),
  };
}
