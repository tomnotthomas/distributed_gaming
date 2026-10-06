// The platform's switch for NVIDIA cards in Swiff OS (GET /api/hosting), read
// from the signaling server's own origin.

import { describe, expect, it, vi } from "vitest";
import { fetchNvidiaHosting, hostingUrl } from "./hosting";

describe("the NVIDIA hosting switch", () => {
  it("is read from the signaling server's HTTPS origin, never over plain http to another PC", () => {
    expect(hostingUrl("wss://swiff.example/room")).toBe("https://swiff.example/api/hosting");
    expect(hostingUrl("swiff.example")).toBe("https://swiff.example/api/hosting");
    expect(hostingUrl("ws://localhost:8080")).toBe("http://localhost:8080/api/hosting");
    expect(hostingUrl("http://swiff.example")).toBeNull();
    expect(hostingUrl("")).toBeNull();
  });

  it("says whether NVIDIA cards may host, and throws on anything else", async () => {
    const answer = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await fetchNvidiaHosting("swiff.example", answer(200, { nvidiaRental: false }))).toBe(false);
    expect(await fetchNvidiaHosting("swiff.example", answer(200, { nvidiaRental: true }))).toBe(true);
    await expect(fetchNvidiaHosting("swiff.example", answer(200, { nvidiaRental: "on" }))).rejects.toThrow();
    await expect(fetchNvidiaHosting("swiff.example", answer(503, {}))).rejects.toThrow();
    await expect(
      fetchNvidiaHosting("http://swiff.example", answer(200, { nvidiaRental: true })),
    ).rejects.toThrow();
  });
});
