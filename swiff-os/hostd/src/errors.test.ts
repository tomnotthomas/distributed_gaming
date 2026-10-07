import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorTrackingEnv, errorTrackingFile, hostdTracker } from "./errors.ts";

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

describe("the error-tracking file Lanterel Host writes onto the ESP", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swiff-hostd-errors-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** The agent's tracker for `text` as the file, with the posts it made. */
  async function fromFile(text: string) {
    const path = join(dir, "LANTEREL.ENV");
    await writeFile(path, text);
    const env = { PATH: "/bin", ...(await errorTrackingFile(path)) };
    return { env, ...tracked(env, []) };
  }

  it("names the project the agent reports to, and the streamer after it", async () => {
    const { env, tracker, posted } = await fromFile(
      "LANTEREL_POSTHOG_KEY=phc_public\r\nLANTEREL_POSTHOG_HOST=https://eu.i.posthog.com\r\n",
    );
    tracker.capture(new Error("boom"));
    await tracker.flush();
    expect(posted.map((p) => p.url)).toEqual(["https://eu.i.posthog.com/i/v0/e/"]);
    expect(errorTrackingEnv(env)).toEqual(project);
  });

  it("gives the agent no other variable", async () => {
    const { env } = await fromFile(
      "NODE_OPTIONS=--require /esp/x.js\nLANTEREL_POSTHOG_KEY=phc_public\nPATH=/esp\nDO_NOT_TRACK=0\n",
    );
    expect(env).toEqual({ PATH: "/bin", LANTEREL_POSTHOG_KEY: "phc_public" });
  });

  it.each([
    [
      "a host off posthog.com",
      "LANTEREL_POSTHOG_KEY=phc_public\nLANTEREL_POSTHOG_HOST=https://evil.example\n",
    ],
    [
      "a key that is not a project's",
      "LANTEREL_POSTHOG_KEY=phx_x\nLANTEREL_POSTHOG_HOST=https://eu.i.posthog.com\n",
    ],
    [
      "more than the file Lanterel Host writes",
      `${"#".repeat(5000)}\nLANTEREL_POSTHOG_KEY=phc_public\nLANTEREL_POSTHOG_HOST=https://eu.i.posthog.com\n`,
    ],
  ])("leaves reports off with %s", async (_what, text) => {
    const { tracker, posted } = await fromFile(text);
    tracker.capture(new Error("boom"));
    await tracker.flush();
    expect(tracker.enabled).toBe(false);
    expect(posted).toEqual([]);
  });

  it("is nothing when there is no file", async () => {
    expect(await errorTrackingFile(join(dir, "missing"))).toEqual({});
    expect(await errorTrackingFile(undefined)).toEqual({});
  });
});
