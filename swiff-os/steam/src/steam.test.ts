import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSignInUrl, lastLoginState, startSteam, steamClient } from "./steam.ts";

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

describe("steamClient.launch", () => {
  let bin: string;
  let path: string | undefined;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "swiff-steam-bin-"));
    path = process.env.PATH;
    process.env.PATH = bin;
  });
  afterEach(async () => {
    process.env.PATH = path;
    await rm(bin, { recursive: true, force: true });
  });

  it("hands the running client the game and resolves once that steam exits", async () => {
    const args = join(bin, "args");
    await writeFile(join(bin, "steam"), `#!/bin/sh\necho "$@" > ${args}\n`);
    await chmod(join(bin, "steam"), 0o755);

    await steamClient(bin).launch(570);

    expect((await readFile(args, "utf8")).trim()).toBe("-applaunch 570");
  });

  it("rejects when steam cannot be run at all, rather than waiting out the launch", async () => {
    await expect(steamClient(bin).launch(570)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/** Steam's KeyValues text (registry.vdf): quoted keys, each with a quoted value or a { block }. */
type KeyValues = { [key: string]: string | KeyValues };
function parseKeyValues(text: string): KeyValues {
  const tokens = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|[{}]/g)].map((m) => m[1] ?? m[0]);
  let at = 0;
  const block = (): KeyValues => {
    const out: KeyValues = {};
    while (at < tokens.length && tokens[at] !== "}") {
      const key = tokens[at++] as string;
      if (tokens[at] === "{") {
        at++;
        out[key] = block();
        at++;
      } else out[key] = tokens[at++] as string;
    }
    return out;
  };
  return block();
}

describe("startSteam", () => {
  let home: string;
  let bin: string;
  let path: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "swiff-steam-home-"));
    bin = await mkdtemp(join(tmpdir(), "swiff-steam-bin-"));
    path = process.env.PATH;
    process.env.PATH = bin;
  });
  afterEach(async () => {
    process.env.PATH = path;
    await rm(home, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  it("sets Steam not to remember the sign-in before Steam starts", async () => {
    const seen = join(bin, "seen");
    // The stand-in Steam records the settings it finds as it starts.
    await writeFile(
      join(bin, "steam"),
      `#!/bin/sh\necho "$@" > ${seen}\nwhile IFS= read -r line; do echo "$line"; done < "$HOME/.steam/registry.vdf" >> ${seen}\n`,
    );
    await chmod(join(bin, "steam"), 0o755);
    await mkdir(join(home, ".steam"));
    await writeFile(
      join(home, ".steam", "registry.vdf"),
      '"Registry" { "HKCU" { "Software" { "Valve" { "Steam" { "AutoLoginUser" "previous" "RememberPassword" "1" } } } } }',
    );

    const steam = startSteam(home);
    await new Promise((resolve) => steam.once("exit", resolve));

    const [args, ...vdf] = (await readFile(seen, "utf8")).split("\n");
    expect(args).toBe("-silent");
    const startedWith = parseKeyValues(vdf.join("\n")) as {
      Registry: { HKCU: { Software: { Valve: { Steam: KeyValues } } } };
    };
    expect(startedWith.Registry.HKCU.Software.Valve.Steam).toMatchObject({
      RememberPassword: "0",
      AutoLoginUser: "",
    });
  });
});
