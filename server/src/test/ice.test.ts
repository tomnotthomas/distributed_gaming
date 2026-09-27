import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { turnServersFromEnv } from "../ice.js";

describe("turnServersFromEnv", () => {
  it("returns nothing when TURN_URLS is unset, so the server sends no iceServers", () => {
    assert.deepEqual(turnServersFromEnv({}), []);
    assert.deepEqual(turnServersFromEnv({ TURN_URLS: " , " }), []);
  });

  it("splits and trims the urls into one server entry with its credentials", () => {
    const servers = turnServersFromEnv({
      TURN_URLS: "turn:t.example:3478, turns:t.example:443?transport=tcp",
      TURN_USERNAME: "u",
      TURN_CREDENTIAL: "p",
    });
    assert.deepEqual(servers, [
      { urls: ["turn:t.example:3478", "turns:t.example:443?transport=tcp"], username: "u", credential: "p" },
    ]);
  });
});
