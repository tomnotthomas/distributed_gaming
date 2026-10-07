// The GStreamer pipelines that turn gamescope's picture and the session's sound
// into RTP, as text for helpers/swiff-gst.py to run.
//
//   pipewiresrc (gamescope) ─► scale/convert ─► H.264 encoder ─► rtph264pay ─┐
//   pipewiresrc (sink monitor) ─► opusenc ─► rtpopuspay ─────────────────────┴─► rtpstreampay ─► stdout
//
// Each pipeline writes its RTP to the helper's stdout, framed by a 2-byte
// length (RFC 4571, rtpstreampay), so nothing else on the PC can feed packets
// in: a local UDP port would take them from any user, the renter's included.
//
// H.264 Constrained Baseline, because every browser decodes it and every GPU
// encodes it. No B-frames, a keyframe whenever the renter's decoder asks for
// one (a PLI, forwarded by the streamer) and otherwise every few seconds.

import type { EncoderChoice, StreamerConfig } from "./config";

/** RTP payload types the streamer offers; peer.ts announces the same. */
export const VIDEO_PT = 96;
export const AUDIO_PT = 111;
/** Room for SRTP and a TURN header inside a 1280-byte path MTU. */
export const RTP_MTU = 1200;
/**
 * What every capture stream tells PipeWire about itself, with its media.type.
 * WirePlumber 0.5 links a stream without media.type only by luck: its fallback
 * fails on one, so a capture started again can find no target.
 */
const CAPTURE_PROPS = "media.category=Capture";
/** The raw formats taken from gamescope's PipeWire stream (system memory). */
export const GAMESCOPE_FORMATS = ["BGRx", "BGRA", "RGBx", "RGBA", "NV12", "I420"];
/** A keyframe at least this often, for a decoder whose PLI got lost. */
export const KEYFRAME_SECONDS = 4;

export type Encoder = Exclude<EncoderChoice, "auto">;

/** The GStreamer element each encoder needs, so the streamer can ask which exist. */
export const ENCODER_ELEMENTS: Record<Encoder, string> = {
  nvenc: "nvh264enc",
  vaapi: "vah264enc",
  x264: "x264enc",
};

/** GPU first: an idle GPU encoder costs the game nothing, x264 costs it CPU. */
export const AUTO_ORDER: Encoder[] = ["nvenc", "vaapi", "x264"];

/** The encoders to try, in order, given the elements this PC has. */
export function encoderCandidates(choice: EncoderChoice, available: ReadonlySet<string>): Encoder[] {
  if (choice !== "auto") return [choice];
  return AUTO_ORDER.filter((e) => available.has(ENCODER_ELEMENTS[e]));
}

type VideoSettings = Pick<
  StreamerConfig,
  "video" | "pipewireTarget" | "width" | "height" | "frameRate" | "bitrate"
>;

/** The video pipeline for one encoder. The encoder is named `enc`, for keyframes and bitrate. */
export function videoPipeline(s: VideoSettings, encoder: Encoder): string {
  const source =
    s.video === "test"
      ? `videotestsrc is-live=true pattern=ball ! ${rawCaps(s)}`
      : // keepalive-time repeats the last frame of a still screen, so the stream never stalls.
        // The formats are gamescope's shared-memory ones: left open, pipewiresrc offers
        // everything videoconvert takes, DMA-BUF layouts included, and negotiation fails.
        `pipewiresrc target-object=${s.pipewireTarget} do-timestamp=true keepalive-time=1000 ` +
        `stream-properties="props,${CAPTURE_PROPS},media.type=Video" ! ` +
        `video/x-raw,format={${GAMESCOPE_FORMATS.join(",")}}`;
  // A frame the encoder cannot take yet is dropped, never queued: latency over smoothness.
  const leaky = "queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream";
  return [
    source,
    leaky,
    encodeChain(s, encoder),
    "h264parse config-interval=-1",
    `rtph264pay pt=${VIDEO_PT} mtu=${RTP_MTU} config-interval=-1 aggregate-mode=zero-latency`,
    "rtpstreampay",
    "fdsink fd=1 sync=false",
  ].join(" ! ");
}

/**
 * A few synthetic frames through the encoder and nothing else, to learn whether
 * it works on this PC before the stream depends on it: an element can exist for
 * a GPU whose driver then refuses the size or the profile.
 */
export function encoderCheckPipeline(s: VideoSettings, encoder: Encoder): string {
  return [`videotestsrc num-buffers=5 ! ${rawCaps(s)}`, encodeChain(s, encoder), "fakesink"].join(" ! ");
}

function rawCaps(s: VideoSettings): string {
  return `video/x-raw,width=${s.width},height=${s.height},framerate=${s.frameRate}/1`;
}

/** Scale and convert for the encoder, encode, and pin the stream to Constrained Baseline. */
function encodeChain(s: VideoSettings, encoder: Encoder): string {
  const kbps = Math.max(1, Math.round(s.bitrate / 1000));
  const gop = s.frameRate * KEYFRAME_SECONDS;
  const size = `width=${s.width},height=${s.height}`;
  const encode: Record<Encoder, string> = {
    nvenc:
      `videoconvert ! videoscale ! video/x-raw,format=NV12,${size} ! ` +
      `nvh264enc name=enc preset=low-latency-hq rc-mode=cbr zerolatency=true bframes=0 ` +
      `bitrate=${kbps} gop-size=${gop}`,
    vaapi:
      `vapostproc ! video/x-raw(memory:VAMemory),format=NV12,${size} ! ` +
      `vah264enc name=enc rate-control=cbr b-frames=0 target-usage=7 ` +
      `bitrate=${kbps} key-int-max=${gop}`,
    x264:
      `videoconvert ! videoscale ! video/x-raw,format=I420,${size} ! ` +
      `x264enc name=enc tune=zerolatency speed-preset=ultrafast bframes=0 ` +
      `bitrate=${kbps} key-int-max=${gop}`,
  };
  return `${encode[encoder]} ! video/x-h264,profile=constrained-baseline,stream-format=byte-stream`;
}

type AudioSettings = Pick<StreamerConfig, "audio" | "audioBitrate">;

/** The audio pipeline, or null when the streamer sends no sound. */
export function audioPipeline(s: AudioSettings): string | null {
  if (s.audio === "off") return null;
  const source =
    s.audio === "test"
      ? "audiotestsrc is-live=true wave=sine freq=440 volume=0.05"
      : // What the renter's session plays: the default sink's monitor.
        `pipewiresrc do-timestamp=true stream-properties="props,stream.capture.sink=true,${CAPTURE_PROPS},media.type=Audio"`;
  return [
    source,
    "audioconvert",
    "audioresample",
    "audio/x-raw,rate=48000,channels=2",
    `opusenc name=enc bitrate=${s.audioBitrate} frame-size=10 audio-type=restricted-lowdelay`,
    `rtpopuspay pt=${AUDIO_PT}`,
    "rtpstreampay",
    "fdsink fd=1 sync=false",
  ].join(" ! ");
}
