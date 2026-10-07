import { describe, expect, it } from "vitest";
import { scrub, scrubText, withoutInviteTokens } from "./scrub.ts";

describe("withoutInviteTokens", () => {
  it("cuts invite and seat links back to their path, plain or encoded, however deep", () => {
    expect(
      withoutInviteTokens({
        $current_url: "https://lanterel.com/invite/abc123",
        nested: [{ href: "/seat/Zx-9_q?x=1" }, "https://x/login?return=%2Finvite%2Fabc"],
        count: 3,
      }),
    ).toEqual({
      $current_url: "https://lanterel.com/invite",
      nested: [{ href: "/seat?x=1" }, "https://x/login?return=%2Finvite"],
      count: 3,
    });
  });
});

describe("scrubText", () => {
  it.each([
    ["GET https://lanterel.com/invite/k3y-t0ken failed", "GET https://lanterel.com/invite failed"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: Bearer <redacted>"],
    ["got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl back", "got <redacted> back"],
    ['{"sessionKey":"s3cr3t","expiresAt":1}', '{"sessionKey":"<redacted>","expiresAt":1}'],
    ["wss://x/host?machineKey=abc&room=1", "wss://x/host?machineKey=<redacted>&room=1"],
    ["openid.sig=AbC%2B&openid.mode=id_res", "openid.sig=<redacted>&openid.mode=id_res"],
    ["api_key: phc_short", "api_key: <redacted>"],
    ["mail tom@example.com now", "mail <email> now"],
    ["player 76561198012345678 left", "player <steam-id> left"],
    ["connect ECONNREFUSED 192.168.1.20:443", "connect ECONNREFUSED <ip>:443"],
    ["peer fe80:0:0:0:1ff:fe23:4567:890a gone", "peer <ip> gone"],
    ["connect ETIMEDOUT 2a02:8070:abcd::5:443", "connect ETIMEDOUT <ip>"],
    ["connect ECONNREFUSED ::1:3000", "connect ECONNREFUSED <ip>"],
    ["listen on [::1]:3000.", "listen on [<ip>]:3000."],
    ["from ::ffff:192.168.1.20, then", "from <ip>, then"],
    ["peer fe80::1ff:fe23%eth0 gone", "peer <ip> gone"],
    ["dns 2001:db8::.", "dns <ip>."],
    ["id 3f2a9c1e-7b4d-4e8a-9f0c-1d2e3f4a5b6c x", "id <redacted> x"],
    ["key k9Jx2mQ8vR4tL7wZ1nB5cH3fD6gS0aYeUiOp", "key <redacted>"],
  ])("%s", (input, output) => {
    expect(scrubText(input)).toBe(output);
  });

  it("cuts user names out of Windows, macOS and Linux paths, in messages and file URLs", () => {
    expect(
      scrubText(
        "ENOENT: open 'C:\\Users\\Tom Smith\\AppData\\x.json' at (/home/tom/app.js:1:2) file:///Users/tom/a.js C:\\\\Users\\\\tom\\\\y file:///C:/Users/tom/z",
      ),
    ).toBe(
      "ENOENT: open 'C:\\Users\\<user>\\AppData\\x.json' at (/home/<user>/app.js:1:2) file:///Users/<user>/a.js C:\\\\Users\\\\<user>\\\\y file:///C:/Users/<user>/z",
    );
  });

  it("leaves ordinary errors, paths and stack frames as they are", () => {
    const plain = [
      "TypeError: Cannot read properties of undefined (reading 'gpu')",
      "    at readPc (/usr/lib/swiff/hostd/src/agent.ts:120:15)",
      "    at node:internal/process/task_queues:95:5",
      "the streamer exited with code 1 after 30000 ms",
      "C:\\Program Files\\Lanterel Host\\resources\\app.asar\\main.cjs:12:3",
      "    at Object.<anonymous> (/opt/lanterel/app/dead/beef.js:10:20)",
      "    at add:12:3 and cafe:1:2 (Foo::bar, std::face, ::, a ::)",
    ].join("\n");
    expect(scrubText(plain)).toBe(plain);
  });

  it("cuts the literal secrets it is given, but not ones too short to tell from words", () => {
    expect(scrubText("room gaming-pc-1 key zz", ["gaming-pc-1", "zz"])).toBe("room <redacted> key zz");
  });
});

describe("scrub", () => {
  it("scrubs every string in plain objects and arrays and leaves other values alone", () => {
    const date = new Date(0);
    expect(scrub({ a: ["mail a@b.de"], b: { c: 76561198012345678, d: date }, e: null }, [])).toEqual({
      a: ["mail <email>"],
      b: { c: 76561198012345678, d: date },
      e: null,
    });
  });
});
