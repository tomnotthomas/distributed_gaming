import { createHash } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pairing } from "./model";
import {
  askPaired,
  keyHashOf,
  newMachineKey,
  PAIR_POLL_MS,
  pairingCode,
  pairLine,
  pairLink,
  pairLocked,
} from "./pairing";
import { usePairing } from "./usePairing";

const SERVER = "wss://lanterel.example";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pairing's parts", () => {
  it("makes a new 256-bit key each time, in base64url as the server's own", () => {
    const [a, b] = [newMachineKey(), newMachineKey()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("hashes the key as the server keeps it, and shows the owner a few characters of it", async () => {
    const key = newMachineKey();
    const hash = await keyHashOf(key);
    expect(hash).toBe(sha256(key));
    expect(pairingCode("3f9a2c" + "0".repeat(58))).toBe("3F9-A2C");
  });

  it("links to the server's own page with the key's hash, never the key", () => {
    const hash = "a".repeat(64);
    expect(pairLink(SERVER, hash)).toBe(`https://lanterel.example/pair?k=${hash}`);
    expect(pairLink("ws://localhost:8080/ws", hash)).toBe(`http://localhost:8080/pair?k=${hash}`);
    expect(pairLink("not a url", hash)).toBeNull();
  });

  it("reads the server's answer: the machine id, not yet, or none", async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const answer = (res: Response | Error) =>
      askPaired(SERVER, "the-key", async (url, init) => {
        asked.push([String(url), init]);
        if (res instanceof Error) throw res;
        return res;
      });
    expect(await answer(json(200, { machineId: "pc-0123456789ab" }))).toEqual({
      machineId: "pc-0123456789ab",
    });
    expect(asked[0]![0]).toBe("https://lanterel.example/api/pairings/mine");
    expect(new Headers(asked[0]![1]?.headers).get("authorization")).toBe("Bearer the-key");
    expect(await answer(json(404, { error: "not-paired" }))).toBe("waiting");
    expect(await answer(json(503, {}))).toBe("unanswered");
    expect(await answer(new Error("offline"))).toBe("unanswered");
    // Not the server's answer (a captive portal's page, say): nothing to keep.
    expect(await answer(new Response("<html>", { status: 200 }))).toBe("unanswered");
    expect(await answer(json(200, { machineId: "a, b" }))).toBe("unanswered");
  });

  it("keeps Go live and Get paid for a paired PC, after rental mode, and never while sharing this desktop", () => {
    const off = { kind: "off" };
    const at = (kind: Pairing["kind"]): Pairing =>
      kind === "paired"
        ? { kind, machineId: "pc-1" }
        : kind === "waiting"
          ? { kind, code: "ABC-DEF", link: "", unanswered: false }
          : kind === "failed"
            ? { kind, why: "" }
            : { kind };
    for (const step of ["live", "paid"]) {
      expect(pairLocked(step, { pairing: at("unpaired"), live: off })).toBe(true);
      expect(pairLocked(step, { pairing: at("waiting"), live: off })).toBe(true);
      expect(pairLocked(step, { pairing: at("failed"), live: off })).toBe(true);
      expect(pairLocked(step, { pairing: at("paired"), live: off })).toBe(false);
      // Not before the saved key is read: a paired PC never flashes the pairing screen.
      expect(pairLocked(step, { pairing: at("checking"), live: off })).toBe(false);
      expect(pairLocked(step, { pairing: at("unpaired"), live: off }, true)).toBe(false);
      expect(pairLocked(step, { pairing: at("unpaired"), live: { kind: "waiting" } })).toBe(false);
    }
    for (const step of ["pc", "steam", "pair", "games", "rental", "settings"])
      expect(pairLocked(step, { pairing: at("unpaired"), live: off })).toBe(false);
    expect(pairLine(at("paired"))).toBe("Paired with Steam");
    expect(pairLine(at("waiting"))).toBe("Waiting for you in the browser");
  });
});

describe("usePairing", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => json(404, { error: "not-paired" }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    // Each test's pairing stops asking with it.
    cleanup();
    vi.unstubAllGlobals();
  });

  const unpaired = { machineId: "gaming-pc-1", machineKey: "", loaded: true };
  /** Asks every few ms, so the tests run on real time. */
  const POLL = 5;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

  it("reads as checking until the saved key is read, then paired or not", () => {
    const keep = vi.fn(async () => true);
    const { result, rerender } = renderHook((saved) => usePairing({ serverUrl: SERVER, saved, keep }), {
      initialProps: { ...unpaired, loaded: false },
    });
    expect(result.current.pairing).toEqual({ kind: "checking" });
    rerender(unpaired);
    expect(result.current.pairing).toEqual({ kind: "unpaired" });
    rerender({ machineId: "pc-1", machineKey: "k", loaded: true });
    expect(result.current.pairing).toEqual({ kind: "paired", machineId: "pc-1" });
  });

  it("opens the page with the key's hash, asks until the owner has added the PC, then keeps its id and key", async () => {
    const keep = vi.fn(async () => true);
    const open = vi.fn();
    const { result } = renderHook(() =>
      usePairing({ serverUrl: SERVER, saved: unpaired, keep, open, pollMs: POLL }),
    );
    act(() => result.current.pair());
    await waitFor(() => expect(result.current.pairing.kind).toBe("waiting"));
    const waiting = result.current.pairing as Extract<Pairing, { kind: "waiting" }>;
    const hash = /\?k=([0-9a-f]{64})$/.exec(waiting.link)![1]!;
    expect(PAIR_POLL_MS).toBe(2_000);
    expect(open).toHaveBeenCalledWith(`https://lanterel.example/pair?k=${hash}`);
    expect(waiting.code).toBe(pairingCode(hash));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(keep).not.toHaveBeenCalled();
    const key = new Headers(fetchMock.mock.calls[0]![1]?.headers)
      .get("authorization")!
      .replace("Bearer ", "");
    expect(sha256(key)).toBe(hash);

    fetchMock.mockImplementation(async () => json(200, { machineId: "pc-0123456789ab" }));
    await waitFor(() => expect(keep).toHaveBeenCalledWith("pc-0123456789ab", key));
    // Done: it asks no more.
    const asked = fetchMock.mock.calls.length;
    await act(() => sleep(POLL * 6));
    expect(fetchMock.mock.calls.length).toBe(asked);
    expect(keep).toHaveBeenCalledOnce();
  });

  it("says so while the server doesn't answer, and keeps asking", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    const { result } = renderHook(() =>
      usePairing({
        serverUrl: SERVER,
        saved: unpaired,
        keep: async () => true,
        open: () => {},
        pollMs: POLL,
      }),
    );
    act(() => result.current.pair());
    await waitFor(() => expect(result.current.pairing).toMatchObject({ kind: "waiting", unanswered: true }));
    fetchMock.mockImplementation(async () => json(404, {}));
    await waitFor(() => expect(result.current.pairing).toMatchObject({ kind: "waiting", unanswered: false }));
  });

  it("stops at a key Windows couldn't keep, in one sentence, until the owner pairs again", async () => {
    fetchMock.mockImplementation(async () => json(200, { machineId: "pc-0123456789ab" }));
    const { result } = renderHook(() =>
      usePairing({
        serverUrl: SERVER,
        saved: unpaired,
        keep: async () => false,
        open: () => {},
        pollMs: POLL,
      }),
    );
    act(() => result.current.pair());
    await waitFor(() =>
      expect(result.current.pairing).toEqual({
        kind: "failed",
        why: "Windows couldn't keep this PC's key encrypted, so the pairing wasn't saved: pair again.",
      }),
    );
    // Pair again: a new key, waiting for the owner again.
    fetchMock.mockImplementation(async () => json(404, {}));
    act(() => result.current.pair());
    await waitFor(() => expect(result.current.pairing.kind).toBe("waiting"));
  });

  it("asks no more once cancelled, and leaves a paired PC as it was", async () => {
    const keep = vi.fn(async () => true);
    const saved = { machineId: "pc-1", machineKey: "k", loaded: true };
    const { result } = renderHook(() =>
      usePairing({ serverUrl: SERVER, saved, keep, open: () => {}, pollMs: POLL }),
    );
    act(() => result.current.pair());
    await waitFor(() => expect(result.current.pairing.kind).toBe("waiting"));
    act(() => result.current.cancel());
    expect(result.current.pairing).toEqual({ kind: "paired", machineId: "pc-1" });
    const asked = fetchMock.mock.calls.length;
    await act(() => sleep(POLL * 6));
    expect(fetchMock.mock.calls.length).toBe(asked);
    expect(keep).not.toHaveBeenCalled();
  });
});
