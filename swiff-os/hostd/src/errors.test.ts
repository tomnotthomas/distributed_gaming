import { describe, expect, it } from "vitest";
import { errorTrackingEnv, hostdTracker } from "./errors.ts";

const project = { LANTEREL_POSTHOG_KEY: "phc_public", LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com" };

/** A tracker whose reports land in `posted` instead of on the network. */
function tracked(env: NodeJS.ProcessEnv, secrets: string[]) {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const tracker = hostdTracker(env, secrets, async (url, body) => {
    posted.push({ url, body: JSON.parse(body) });
  });
  return { tracker, posted };
}

describe("hostd's error reports", () => {
  it("go to the project as swiff-hostd's, without the machine key or id read after it started", async () => {
    const secrets: string[] = [];
    const { tracker, posted } = tracked(project, secrets);
    secrets.push("gaming-pc-1", "mk_live_0123456789abcdefghij");
    tracker.capture(new Error("register refused for gaming-pc-1 with key mk_live_0123456789abcdefghij"));
    await tracker.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(posted[0]!.body).toMatchObject({
      event: "$exception",
      api_key: "phc_public",
      properties: { service: "swiff-hostd" },
    });
    const sent = JSON.stringify(posted[0]!.body);
    expect(sent).not.toContain("gaming-pc-1");
    expect(sent).not.toContain("mk_live_0123456789abcdefghij");
  });

  it("are off without a project, and with DO_NOT_TRACK", async () => {
    for (const env of [{}, { ...project, DO_NOT_TRACK: "1" }]) {
      const { tracker, posted } = tracked(env, []);
      tracker.capture(new Error("boom"));
      await tracker.flush();
      expect(tracker.enabled).toBe(false);
      expect(posted).toEqual([]);
    }
  });

  it("are configured for the streamer by the same variables, and only those", () => {
    expect(errorTrackingEnv({ ...project, DO_NOT_TRACK: "1", SWIFF_MACHINE_KEY: "x", PATH: "/bin" })).toEqual(
      {
        ...project,
        DO_NOT_TRACK: "1",
      },
    );
    expect(errorTrackingEnv({ PATH: "/bin" })).toEqual({});
  });
});
