// Unit tests for tickets and machine keys. The server tests cover how a room
// uses them; these cover the credentials themselves.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessFromEnv,
  mintTicket,
  newMachineKey,
  parseMachineKeys,
  verifyMachineKey,
  verifyTicket,
} from "../access.js";

const SECRET = "a-secret-that-is-at-least-32-characters";

describe("join tickets", () => {
  it("round-trips room, id and expiry", () => {
    const now = 1_700_000_000_000;
    const ticket = verifyTicket(SECRET, mintTicket(SECRET, "pc-1", 600, now), now);
    assert.equal(ticket?.room, "pc-1");
    assert.equal(ticket?.exp, now / 1000 + 600);
    assert.ok(ticket?.id);
  });

  it("gives every ticket its own id", () => {
    const a = verifyTicket(SECRET, mintTicket(SECRET, "pc-1", 600));
    const b = verifyTicket(SECRET, mintTicket(SECRET, "pc-1", 600));
    assert.notEqual(a?.id, b?.id);
  });

  it("rejects an expired ticket", () => {
    const now = Date.now();
    const token = mintTicket(SECRET, "pc-1", 60, now);
    assert.ok(verifyTicket(SECRET, token, now + 59_000));
    assert.equal(verifyTicket(SECRET, token, now + 60_000), null);
  });

  it("rejects a ticket signed with another secret", () => {
    assert.equal(verifyTicket(SECRET, mintTicket(`${SECRET}-other`, "pc-1", 600)), null);
  });

  it("rejects a ticket whose room was edited", () => {
    const [, signature] = mintTicket(SECRET, "pc-1", 600).split(".");
    const payload = Buffer.from(
      JSON.stringify({ room: "pc-2", id: "x", exp: Date.now() / 1000 + 600 }),
    ).toString("base64url");
    assert.equal(verifyTicket(SECRET, `${payload}.${signature}`), null);
  });

  it("rejects anything that is not a ticket", () => {
    for (const token of [undefined, null, 42, "", "a", "a.b", "a.b.c", "..."]) {
      assert.equal(verifyTicket(SECRET, token), null, `accepted ${String(token)}`);
    }
  });
});

describe("machine keys", () => {
  it("accepts the key the hash was made from, and nothing else", () => {
    const { key, hash } = newMachineKey();
    const keys = parseMachineKeys(`pc-1:${hash}`);
    assert.ok(verifyMachineKey(keys, "pc-1", key));
    assert.ok(!verifyMachineKey(keys, "pc-1", `${key}x`));
    assert.ok(!verifyMachineKey(keys, "pc-2", key));
    assert.ok(!verifyMachineKey(keys, "pc-1", undefined));
  });

  it("skips malformed entries instead of failing", () => {
    const { hash } = newMachineKey();
    const keys = parseMachineKeys(` pc-1:${hash} , broken, pc-2:not-hex, :${hash}`);
    assert.deepEqual([...keys.keys()], ["pc-1"]);
  });
});

describe("accessFromEnv", () => {
  it("refuses a secret too short to be safe", () => {
    assert.equal(accessFromEnv({ ROOM_SECRET: "short" }).secret, null);
    assert.equal(accessFromEnv({}).secret, null);
    assert.equal(accessFromEnv({ ROOM_SECRET: SECRET }).secret, SECRET);
  });
});
