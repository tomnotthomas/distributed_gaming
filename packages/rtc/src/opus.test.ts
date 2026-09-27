// Unit tests for the Opus stereo munge.
//
// This edits an SDP by hand, which is the kind of code that works on the one
// offer it was written against and breaks on the next browser version. The
// cases pinned here are the ones that would fail quietly: a payload type that
// is not 111, an fmtp line that already exists and carries parameters worth
// keeping, CRLF terminators, and an offer with no audio at all.

import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_BITRATE, preferStereoOpus, withStereoOpus } from "./opus";

/** An offer shaped like the ones Chrome produces, CRLF and all. */
function sdp(lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

const VIDEO_ONLY = sdp([
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
]);

const WITH_OPUS = sdp([
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
]);

/** The fmtp parameters for a payload type, as a set. */
function params(out: string, pt = "111"): Set<string> {
  const line = out.split("\r\n").find((l) => l.startsWith(`a=fmtp:${pt} `));
  return new Set((line ?? "").slice(`a=fmtp:${pt} `.length).split(";"));
}

describe("preferStereoOpus", () => {
  it("asks for stereo in both directions and a bitrate worth having", () => {
    const out = params(preferStereoOpus(WITH_OPUS));

    expect(out).toContain("stereo=1");
    expect(out).toContain("sprop-stereo=1");
    expect(out).toContain(`maxaveragebitrate=${DEFAULT_AUDIO_BITRATE}`);
  });

  // Dropping these is how you trade stereo for a worse artefact: useinbandfec
  // is what keeps audio intact across the packet loss TURN paths produce.
  it("keeps the parameters the browser negotiated", () => {
    const out = params(preferStereoOpus(WITH_OPUS));

    expect(out).toContain("minptime=10");
    expect(out).toContain("useinbandfec=1");
  });

  it("leaves an offer with no audio completely alone", () => {
    expect(preferStereoOpus(VIDEO_ONLY)).toBe(VIDEO_ONLY);
  });

  // 111 is conventional, not guaranteed; a hardcoded payload type edits the
  // wrong codec or nothing at all.
  it("finds Opus at whatever payload type this session negotiated", () => {
    const odd = WITH_OPUS.replace(/111/g, "120");
    const out = preferStereoOpus(odd);

    expect(params(out, "120")).toContain("stereo=1");
    expect(out).not.toContain("a=fmtp:111");
  });

  it("adds an fmtp line when the offer carries none", () => {
    const bare = sdp([
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=rtcp-fb:111 transport-cc",
    ]);
    const out = preferStereoOpus(bare);

    expect(params(out)).toContain("stereo=1");
    // Inserted directly after its rtpmap, not appended to the end of the SDP.
    expect(out).toContain("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 ");
    expect(out).toContain("a=rtcp-fb:111 transport-cc");
  });

  // A mangled line ending is rejected wholesale, and the error names nothing.
  it("leaves every line terminator intact", () => {
    const out = preferStereoOpus(WITH_OPUS);

    expect(out.split("\r\n").length).toBe(WITH_OPUS.split("\r\n").length);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("does not stack duplicates when applied twice", () => {
    const once = preferStereoOpus(WITH_OPUS);
    const twice = preferStereoOpus(once);

    expect(twice).toBe(once);
    expect([...params(twice)].filter((p) => p === "stereo=1")).toHaveLength(1);
  });

  it("honours a caller-supplied bitrate", () => {
    expect(params(preferStereoOpus(WITH_OPUS, 64_000))).toContain("maxaveragebitrate=64000");
  });
});

describe("withStereoOpus", () => {
  it("returns a description of the same type with the sdp tuned", () => {
    const out = withStereoOpus({ type: "offer", sdp: WITH_OPUS });

    expect(out.type).toBe("offer");
    expect(params(out.sdp!)).toContain("stereo=1");
  });

  it("passes through a description carrying no sdp", () => {
    const empty = { type: "offer" } as RTCSessionDescriptionInit;

    expect(withStereoOpus(empty)).toBe(empty);
  });
});
