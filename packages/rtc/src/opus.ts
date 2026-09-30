// Opus, talked into carrying a soundtrack instead of a voice call.
//
// WebRTC's audio defaults are tuned for speech: Opus negotiates a single
// channel at a bitrate that makes a game's music sound like a phone call, and
// there is no API for changing either. The only lever is the `a=fmtp` line in
// the SDP, which means editing the offer and answer by hand before they are
// applied.
//
//   stereo=1          I can receive two channels
//   sprop-stereo=1    I intend to send two channels
//   maxaveragebitrate the ceiling Opus is allowed to use
//
// Both peers have to say it. A host that sends `sprop-stereo=1` to a renter
// that never answers `stereo=1` still collapses to mono, which is exactly the
// kind of failure that sounds like "the audio is a bit flat" rather than like a
// bug, so it goes unreported for months.

/** Enough for game audio without competing with the video for bandwidth. */
export const DEFAULT_AUDIO_BITRATE = 128_000;

// The payload type is negotiated per session, so it has to be read, not guessed.
const OPUS_LINE = /^a=rtpmap:(\d+) opus\/48000\/2[^\r\n]*/im;

/** Parameters we set, and therefore replace rather than duplicate. */
const OURS = /^(stereo|sprop-stereo|maxaveragebitrate)=/i;

/**
 * Add stereo and a sane bitrate to the Opus format line.
 *
 * Returns the SDP untouched when there is no Opus track to tune — a
 * video-only offer is the normal case until the host captures audio.
 */
export function preferStereoOpus(sdp: string, bitrate = DEFAULT_AUDIO_BITRATE): string {
  const opus = OPUS_LINE.exec(sdp);
  if (!opus) return sdp;

  const pt = opus[1];
  const wanted = `stereo=1;sprop-stereo=1;maxaveragebitrate=${bitrate}`;

  // Match the parameters only: the line terminator stays where it is, because
  // an SDP with a mangled CRLF is rejected wholesale and blames nothing.
  const existing = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, "m");

  if (existing.test(sdp)) {
    return sdp.replace(existing, (_line, params: string) => {
      // Keep whatever else the browser negotiated; only our three are replaced.
      const kept = params
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p !== "" && !OURS.test(p));
      return `a=fmtp:${pt} ${[...kept, wanted].join(";")}`;
    });
  }

  return sdp.replace(OPUS_LINE, (line) => `${line}\r\na=fmtp:${pt} ${wanted}`);
}

/**
 * Apply the tuning to a description, leaving one without Opus alone.
 *
 * Munging what `createOffer` produced is discouraged and, for this one
 * parameter, is also the only way — so callers should treat a rejection as
 * recoverable and fall back to the untouched description rather than losing
 * the session over the audio being mono.
 */
export function withStereoOpus(
  description: RTCSessionDescriptionInit,
  bitrate = DEFAULT_AUDIO_BITRATE,
): RTCSessionDescriptionInit {
  if (!description.sdp) return description;
  return { type: description.type, sdp: preferStereoOpus(description.sdp, bitrate) };
}

/**
 * Apply a local description, preferring the stereo-tuned version of it.
 *
 * Editing SDP that `createOffer` or `createAnswer` produced is discouraged,
 * and for Opus stereo it is also the only option. A browser that refuses the
 * edit should cost the session its second audio channel, never the session
 * itself — so the untouched description is applied instead and the reason is
 * said out loud. Without audio there is nothing to tune.
 */
export async function setLocalWithStereoOpus(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit,
  hasAudio: boolean,
  bitrate = DEFAULT_AUDIO_BITRATE,
): Promise<void> {
  if (!hasAudio) return pc.setLocalDescription(description);
  try {
    await pc.setLocalDescription(withStereoOpus(description, bitrate));
  } catch (cause) {
    console.warn(
      "[swiff] stereo Opus was rejected; falling back to mono",
      cause instanceof Error ? cause.name : typeof cause,
    );
    await pc.setLocalDescription(description);
  }
}
