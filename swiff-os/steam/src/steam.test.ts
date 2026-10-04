import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSignInUrl, lastLoginState, steamClient } from "./steam.ts";

// steamui_login.txt from the test VM's Steam at its sign-in window.
const SIGNED_OUT = `[2026-10-04 14:20:15] Client version: 1788652215
[2026-10-04 14:20:15] [ None ] SetLoginState: WaitingForCredentials - OK
[2026-10-04 14:20:16] [ WaitingForCredentials ] UI Request: connect
[2026-10-04 14:21:26] [ WaitingForCredentials ] Received logon failure response
`;
// The same log once a sign-in goes through, with the states the client names.
const SIGNED_IN = `${SIGNED_OUT}[2026-10-04 14:22:03] [ WaitingForCredentials ] SetLoginState: WaitingForServerResponse - OK
[2026-10-04 14:22:04] [ WaitingForServerResponse ] SetLoginState: WaitingForLibraryReady - OK
[2026-10-04 14:22:06] [ WaitingForLibraryReady ] SetLoginState: Success - OK
`;

describe("isSignInUrl", () => {
  it("takes Steam's sign-in links only", () => {
    expect(isSignInUrl("https://s.team/q/1/1234567890123456789")).toBe(true);
    for (const text of [
      "http://s.team/q/1/1234567890123456789",
      "https://s.team/q/1/1234567890123456789/x",
      "https://s.team.evil.example/q/1/1",
      "https://s.team/p/1/1",
      "steam://open/main",
    ])
      expect(isSignInUrl(text)).toBe(false);
  });
});

describe("lastLoginState", () => {
  it("reads the sign-in state Steam logged last", () => {
    expect(lastLoginState(SIGNED_OUT)).toBe("WaitingForCredentials");
    expect(lastLoginState(SIGNED_IN)).toBe("Success");
    expect(lastLoginState("[2026-10-04 14:20:15] Client version: 1788652215\n")).toBeNull();
  });
});

describe("steamClient.signedIn", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "swiff-steam-home-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const logAs = async (text: string) => {
    await mkdir(join(home, ".steam", "steam", "logs"), { recursive: true });
    await writeFile(join(home, ".steam", "steam", "logs", "steamui_login.txt"), text);
  };

  it("is signed in once Steam logs Success, not while it waits for the renter", async () => {
    const steam = steamClient(home);
    expect(await steam.signedIn()).toBe(false);
    await logAs(SIGNED_OUT);
    expect(await steam.signedIn()).toBe(false);
    await logAs(SIGNED_IN);
    expect(await steam.signedIn()).toBe(true);
  });
});
