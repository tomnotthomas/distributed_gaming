// One werift peer connection for one renter connection: a sendonly H.264
// track, an Opus track when there is sound, and nothing to encode — the tracks
// pass on RTP the capture helpers already made.
//
// The codecs offered are exactly what pipeline.ts produces: werift rewrites
// each packet's header for its sender (SSRC, payload type, sequence, timestamp)
// but never the payload, so an offer the encoder does not match would reach
// the renter as garbage.

import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useNACK,
  usePLI,
  type RTCRtpSender,
} from "werift";
import { AUDIO_PT, VIDEO_PT } from "./pipeline";

export type PeerOptions = {
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  icePortRange: [number, number] | null;
  audio: boolean;
};

type Outgoing = { track: MediaStreamTrack; sender: RTCRtpSender };
export type Peer = { pc: RTCPeerConnection; video: Outgoing; audio: Outgoing | null };

/** Constrained Baseline 3.1, the profile every browser takes; the encoder is pinned to it. */
export const H264_FMTP = "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1";
/** Stereo, as the desktop host sends it (@swiff/rtc's opus.ts), with in-band FEC. */
export const OPUS_FMTP = "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1";

export function createPeer({ iceServers, forceRelay, icePortRange, audio }: PeerOptions): Peer {
  const pc = new RTCPeerConnection({
    iceServers: iceServers.map(({ urls, username, credential }) => ({ urls, username, credential })),
    iceTransportPolicy: forceRelay ? "relay" : "all",
    icePortRange: icePortRange ?? undefined,
    bundlePolicy: "max-bundle",
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90_000,
          payloadType: VIDEO_PT,
          // NACK: werift resends from its own history. PLI: a keyframe on request.
          rtcpFeedback: [useNACK(), usePLI()],
          parameters: H264_FMTP,
        }),
      ],
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48_000,
          channels: 2,
          payloadType: AUDIO_PT,
          parameters: OPUS_FMTP,
        }),
      ],
    },
  });

  // One stream for both tracks: the renter page plays `event.streams[0]`, and
  // sound on the same stream stays in sync with the picture.
  const stream = new MediaStream();
  const outgoing = (kind: "video" | "audio"): Outgoing => {
    const track = new MediaStreamTrack({ kind });
    const { sender } = pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    return { track, sender };
  };
  return { pc, video: outgoing("video"), audio: audio ? outgoing("audio") : null };
}
