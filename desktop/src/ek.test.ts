// @vitest-environment node
// Registering this PC's TPM identity with the server (ek.ts), against a fake
// Host API: the EK goes up only when the server has another one or none, and
// every answer comes back as one of the reasons the Go live screen words.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registerEk } from "./ek";
import EK from "./test/ek-chain.json";

const MACHINE = { url: "wss://swiff.example/ws", machineId: "pc 1", machineKey: "the-key" };
const ROUTE = "https://swiff.example/api/machines/pc%201/ek";
const CHAIN = { certificate: EK.ek, intermediates: [EK.intermediate] };
const FINGERPRINT = createHash("sha256").update(Buffer.from(EK.ek, "base64")).digest("hex");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Host API that has `fingerprint` registered and answers a PUT with `put`. */
function server(fingerprint: string | null, put: () => Response = () => new Response(null, { status: 204 })) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(ROUTE);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer the-key");
    return init?.method === "PUT" ? put() : json(200, { fingerprint });
  });
}

describe("registering the TPM's EK", () => {
  it("registers it, with its intermediates, when the server has none", async () => {
    const fetch = server(null);
    expect(await registerEk(MACHINE, CHAIN, fetch)).toEqual({ ok: true, registered: "now" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, put] = fetch.mock.calls[1]!;
    expect(put?.method).toBe("PUT");
    expect(JSON.parse(String(put?.body))).toEqual(CHAIN);
  });

  it("leaves the one the server has alone: registering it again would hold the PC for a day", async () => {
    const fetch = server(FINGERPRINT);
    expect(await registerEk(MACHINE, CHAIN, fetch)).toEqual({ ok: true, registered: "already" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("registers a new TPM's over the old one", async () => {
    const fetch = server("00".repeat(32));
    expect(await registerEk(MACHINE, CHAIN, fetch)).toEqual({ ok: true, registered: "now" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("goes on when the server attests without EKs", async () => {
    const fetch = vi.fn(async () => json(503, { error: "not-configured" }));
    expect(await registerEk(MACHINE, CHAIN, fetch)).toEqual({ ok: true, registered: "not-needed" });
  });

  it("says why the server refused", async () => {
    const refused = (status: number, body: unknown) =>
      registerEk(
        MACHINE,
        CHAIN,
        server(null, () => json(status, body)),
      );
    expect(await refused(401, { error: "unauthorized" })).toEqual({ ok: false, error: "bad-key" });
    expect(await refused(404, { error: "not-found" })).toEqual({ ok: false, error: "unknown-machine" });
    const untrusted = { error: "attestation-refused", reason: "evidence-rejected", detail: "ek-untrusted" };
    expect(await refused(403, untrusted)).toEqual({ ok: false, error: "untrusted" });
    expect(await refused(403, { ...untrusted, detail: "ek-unsupported" })).toEqual({
      ok: false,
      error: "untrusted",
    });
    expect(await refused(400, { error: "bad-request" })).toEqual({ ok: false, error: "unavailable" });
    expect(await refused(500, null)).toEqual({ ok: false, error: "unavailable" });
    expect(await refused(503, { error: "verifier-unavailable" })).toEqual({
      ok: false,
      error: "unavailable",
    });
    // The machine key refused on the first ask: nothing goes up.
    const fetch = vi.fn(async () => json(401, { error: "unauthorized" }));
    expect(await registerEk(MACHINE, CHAIN, fetch)).toEqual({ ok: false, error: "bad-key" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails without throwing when the server does not answer or the address is no good", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await registerEk(MACHINE, CHAIN, down)).toEqual({ ok: false, error: "failed" });
    expect(await registerEk({ ...MACHINE, url: "not a url" }, CHAIN, down)).toEqual({
      ok: false,
      error: "failed",
    });
  });
});
