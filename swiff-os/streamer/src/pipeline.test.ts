import { describe, expect, it } from "vitest";
import { createRtpDeframer } from "./rtpFrames";
import {
  audioPipeline,
  encoderCandidates,
  encoderCheckPipeline,
  KEYFRAME_SECONDS,
  videoPipeline,
} from "./pipeline";

const VIDEO = {
  video: "pipewire" as const,
  pipewireTarget: "gamescope",
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrate: 10_000_000,
};

describe("encoderCandidates", () => {
  it("tries the GPU encoders this PC has before x264", () => {
    expect(encoderCandidates("auto", new Set(["x264enc", "vah264enc"]))).toEqual(["vaapi", "x264"]);
    expect(encoderCandidates("auto", new Set(["x264enc", "vah264enc", "nvh264enc"]))).toEqual([
      "nvenc",
      "vaapi",
      "x264",
    ]);
    expect(encoderCandidates("auto", new Set())).toEqual([]);
  });

  it("takes an encoder the image names as the only one", () => {
    expect(encoderCandidates("vaapi", new Set())).toEqual(["vaapi"]);
  });
});

describe("videoPipeline", () => {
  it("captures gamescope's PipeWire node and ends in length-framed RTP on stdout", () => {
    const p = videoPipeline(VIDEO, "x264");
    expect(p).toMatch(
      /^pipewiresrc target-object=gamescope .* ! video\/x-raw,format=\{BGRx,BGRA,RGBx,RGBA,NV12,I420\} ! /,
    );
    expect(p).toMatch(/ ! rtph264pay pt=96 mtu=1200 .* ! rtpstreampay ! fdsink fd=1 sync=false$/);
    // WirePlumber 0.5 links a capture stream reliably only when it names its media type.
    expect(p).toContain('stream-properties="props,media.category=Capture,media.type=Video"');
    // No queue that could hold a stale frame for the renter.
    expect(p).toContain("leaky=downstream");
  });

  it.each(["nvenc", "vaapi", "x264"] as const)(
    "has %s name its encoder `enc`, at the bitrate, with no B-frames",
    (encoder) => {
      const p = videoPipeline(VIDEO, encoder);
      expect(p).toMatch(/ name=enc /);
      expect(p).toContain("bitrate=10000 ");
      expect(p).toMatch(/b-?frames=0/);
      expect(p).toContain(`=${60 * KEYFRAME_SECONDS}`);
      expect(p).toContain("video/x-h264,profile=constrained-baseline");
    },
  );

  it("draws a synthetic picture of the right size for a VM or a test", () => {
    expect(videoPipeline({ ...VIDEO, video: "test", width: 1280, height: 720 }, "x264")).toMatch(
      /^videotestsrc is-live=true pattern=ball ! video\/x-raw,width=1280,height=720,framerate=60\/1 /,
    );
  });

  it("checks an encoder on a few synthetic frames and no output", () => {
    const p = encoderCheckPipeline(VIDEO, "vaapi");
    expect(p).toMatch(/^videotestsrc num-buffers=5 /);
    expect(p).toContain("vah264enc name=enc");
    expect(p).toMatch(/ ! fakesink$/);
  });
});

describe("audioPipeline", () => {
  it("captures what the session plays as stereo Opus", () => {
    const p = audioPipeline({ audio: "pipewire", audioBitrate: 128_000 })!;
    expect(p).toContain("stream.capture.sink=true");
    // WirePlumber 0.5 links a capture stream reliably only when it names its media type.
    expect(p).toContain("media.type=Audio");
    expect(p).toContain("opusenc name=enc bitrate=128000");
    expect(p).toMatch(/rtpopuspay pt=111 ! rtpstreampay ! fdsink fd=1 sync=false$/);
  });

  it("sends no sound when told not to", () => {
    expect(audioPipeline({ audio: "off", audioBitrate: 128_000 })).toBeNull();
  });
});

describe("createRtpDeframer", () => {
  const frame = (...bodies: string[]) =>
    Buffer.concat(
      bodies.map((b) => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(b.length);
        return Buffer.concat([len, Buffer.from(b)]);
      }),
    );

  it("finds every packet however the stream is chunked", () => {
    const stream = frame("first", "", "second packet", "x");
    for (let size = 1; size <= stream.length; size++) {
      const out: string[] = [];
      const feed = createRtpDeframer((p) => out.push(p.toString()));
      for (let at = 0; at < stream.length; at += size) feed(stream.subarray(at, at + size));
      expect(out).toEqual(["first", "second packet", "x"]);
    }
  });

  it("hands out copies, so a kept packet does not hold the chunk it came in", () => {
    const out: Buffer[] = [];
    const chunk = frame("abc");
    createRtpDeframer((p) => out.push(p))(chunk);
    chunk.fill(0);
    expect(out[0]!.toString()).toBe("abc");
  });
});
