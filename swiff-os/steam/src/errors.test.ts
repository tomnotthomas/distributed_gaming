import { describe, expect, it } from "vitest";
import { steamLoginTracker } from "./errors.ts";

const project = { LANTEREL_POSTHOG_KEY: "phc_public", LANTEREL_POSTHOG_HOST: "https://eu.i.posthog.com" };

describe("swiff-steam-login's error reports", () => {
  it("go to the project as swiff-steam-login's, without the renter's Steam ID or user name", async () => {
    const posted: Record<string, unknown>[] = [];
    const tracker = steamLoginTracker(project, async (_url, body) => {
      posted.push(JSON.parse(body));
    });
    tracker.capture(new Error("spawn /home/renter/.steam/steam.sh ENOENT for 76561198012345678"));
    await tracker.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: "$exception", properties: { service: "swiff-steam-login" } });
    const sent = JSON.stringify(posted[0]);
    expect(sent).not.toContain("76561198012345678");
    expect(sent).not.toContain("/home/renter");
  });

  it("are off without a project", () => {
    expect(steamLoginTracker({}).enabled).toBe(false);
  });
});
