import { describe, expect, it } from "vitest";
import { streamerTracker } from "./errors";

const project = { LANTEREL_POSTHOG_KEY: "phc_public", LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com" };

describe("the streamer's error reports", () => {
  it("go to hostd's project as swiff-streamer's, without the machine id or a session key", async () => {
    const posted: Record<string, unknown>[] = [];
    const tracker = streamerTracker({ ...project, SWIFF_HOST_ID: "gaming-pc-1" }, async (_url, body) => {
      posted.push(JSON.parse(body));
    });
    const sessionKey = "sk_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a";
    tracker.capture(new Error(`gaming-pc-1 refused session key ${sessionKey}`));
    await tracker.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: "$exception", properties: { service: "swiff-streamer" } });
    const sent = JSON.stringify(posted[0]);
    expect(sent).not.toContain("gaming-pc-1");
    expect(sent).not.toContain(sessionKey);
  });

  it("are off when hostd passed no project on", () => {
    expect(streamerTracker({ SWIFF_HOST_ID: "gaming-pc-1" }).enabled).toBe(false);
  });
});
