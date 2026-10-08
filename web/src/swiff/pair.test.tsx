// Pairing a PC (/pair?k=<hash>): the address Lanterel on the PC opens, the
// code the owner compares, Steam sign-in back to it, adding the PC, and every
// way adding can be refused, each with one sentence and one button.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutInviteTokens } from "./invite";
import { addPc, pairingCode, pairKeyAt, signInToPair } from "./pair";
import { PairPc } from "./PairPc";
import { pathOf, screenAt } from "./route";
import { ScreenLang, screenLang } from "./screenCopy";
import type { Swiff } from "./useSwiff";

const K = "3f9a2c" + "0123456789abcdef".repeat(3) + "0123456789";

/** A fetch answering POST /api/pairings with `status` and `body`, and sign-out with 204. */
function answering(status: number, body: unknown) {
  const get = vi.fn(async (url: string) =>
    url === "/api/signout"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", get);
  return get;
}

/** The Swiff hook as the pairing page reads it. */
function fakeSwiff(over: Record<string, unknown> = {}): Swiff {
  return {
    signedIn: true,
    signInKnown: true,
    openCrew: vi.fn(),
    goHome: vi.fn(),
    ...over,
  } as unknown as Swiff;
}

const at = (path: string) => history.replaceState(null, "", path);
const onPairScreen = (swiff: Swiff) => (
  <ScreenLang.Provider value={screenLang("pair", "en")}>
    <PairPc swiff={swiff} />
  </ScreenLang.Provider>
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("pairing addresses", () => {
  it("reads the key hash from /pair, and only a whole one", () => {
    expect(pairKeyAt("/pair", `?k=${K}`)).toBe(K);
    expect(pairKeyAt("/pair/", `?k=${K}`)).toBe(K);
    expect(pairKeyAt("/pair", "")).toBe("");
    expect(pairKeyAt("/pair", `?k=${K.toUpperCase()}`)).toBe("");
    expect(pairKeyAt("/pair", `?k=${K.slice(1)}`)).toBe("");
    expect(pairKeyAt("/crews", `?k=${K}`)).toBeNull();
  });

  it("opens the pairing screen at /pair, which keeps its own address", () => {
    expect(screenAt("/pair")).toBe("pair");
    expect(pathOf("pair")).toBe("/pair");
  });

  it("shows the code the app shows, and signs in back to the pairing", () => {
    expect(pairingCode(K)).toBe("3F9-A2C");
    expect(signInToPair(K)).toBe("/auth/steam/login?to=%2Fpair");
    expect(sessionStorage.getItem("swiff.pair")).toBe(K);
  });

  it("keeps the key hash out of the Steam round trip, unless storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(signInToPair(K)).toBe(`/auth/steam/login?to=${encodeURIComponent(`/pair?k=${K}`)}`);
  });

  it("cuts every key hash out of an analytics event", () => {
    const event = {
      properties: {
        $current_url: `https://lanterel.de/pair?k=${K}`,
        $referrer: `https://lanterel.de/auth/steam/login?to=${encodeURIComponent(`/pair?k=${K}`)}`,
        $pathname: `/pair?k=${K}&x=1`,
      },
    };
    expect(JSON.stringify(withoutInviteTokens(event))).not.toContain(K);
    expect(withoutInviteTokens(event).properties).toEqual({
      $current_url: "https://lanterel.de/pair",
      $referrer: "https://lanterel.de/auth/steam/login?to=%2Fpair",
      $pathname: "/pair?x=1",
    });
  });
});

describe("addPc", () => {
  it("adds the PC, new or already the owner's", async () => {
    const get = answering(201, { machineId: "pc-1" });
    expect(await addPc(K)).toEqual({ machineId: "pc-1" });
    expect(get).toHaveBeenCalledWith(
      "/api/pairings",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ keyHash: K }) }),
    );
    answering(200, { machineId: "pc-1" });
    expect(await addPc(K)).toEqual({ machineId: "pc-1" });
  });

  it("says why it was refused, or that nothing answered", async () => {
    answering(409, { code: "paired-elsewhere" });
    expect(await addPc(K)).toBe("paired-elsewhere");
    answering(409, { code: "too-many" });
    expect(await addPc(K)).toBe("too-many");
    answering(401, { error: "sign in with Steam first" });
    expect(await addPc(K)).toBe("signed-out");
    answering(500, { error: "boom" });
    expect(await addPc(K)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    expect(await addPc(K)).toBeNull();
  });
});

describe("the pairing page", () => {
  it("signed out: the code, and Steam sign-in that comes back here", () => {
    at(`/pair?k=${K}`);
    render(onPairScreen(fakeSwiff({ signedIn: false })));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Add this PC");
    expect(screen.getByLabelText("Lanterel on your PC shows 3F9-A2C").textContent).toBe("3F9-A2C");
    const signIn = screen.getByRole("link", { name: /Sign in with Steam/ });
    expect(signIn.getAttribute("href")).toBe(signInToPair(K));
    expect(screen.queryByRole("button", { name: /Add this PC/ })).toBeNull();
    // This tab holds the hash now: it leaves the address bar.
    expect(location.search).toBe("");
    expect(sessionStorage.getItem("swiff.pair")).toBe(K);
  });

  it("back from Steam sign-in at plain /pair: the PC this tab remembers, added on the owner's click", async () => {
    sessionStorage.setItem("swiff.pair", K);
    at("/pair");
    const get = answering(201, { machineId: "pc-1" });
    render(onPairScreen(fakeSwiff()));
    expect(screen.getByLabelText("Lanterel on your PC shows 3F9-A2C").textContent).toBe("3F9-A2C");
    fireEvent.click(screen.getByRole("button", { name: /Add this PC/ }));
    await screen.findByText("Go back to Lanterel on your PC: it carries on by itself.");
    expect(get).toHaveBeenCalledWith(
      "/api/pairings",
      expect.objectContaining({ body: JSON.stringify({ keyHash: K }) }),
    );
    expect(sessionStorage.getItem("swiff.pair")).toBeNull();
  });

  it("signed in: adds the PC on the owner's click, then sends them back to the app", async () => {
    at(`/pair?k=${K}`);
    const get = answering(201, { machineId: "pc-1" });
    const swiff = fakeSwiff();
    render(onPairScreen(swiff));
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Add this PC/ }));
    await screen.findByText("Go back to Lanterel on your PC: it carries on by itself.");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("This PC is yours now");
    expect(location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Go to your crews/ }));
    expect(swiff.openCrew).toHaveBeenCalled();
  });

  it("another account has the PC: one sentence, and signing in with that account", async () => {
    at(`/pair?k=${K}`);
    const get = answering(409, { code: "paired-elsewhere" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign, pathname: "/pair", search: `?k=${K}` });
    render(onPairScreen(fakeSwiff()));
    fireEvent.click(screen.getByRole("button", { name: /Add this PC/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Another Steam account already has this PC: sign in with that account to add it.",
    );
    fireEvent.click(screen.getByRole("button", { name: /Sign in with another account/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(signInToPair(K)));
    expect(get).toHaveBeenCalledWith("/api/signout", { method: "POST" });
  });

  it("no answer: says so, and tries again", async () => {
    at(`/pair?k=${K}`);
    answering(503, {});
    render(onPairScreen(fakeSwiff()));
    fireEvent.click(screen.getByRole("button", { name: /Add this PC/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Lanterel didn't answer: check your connection and try again.",
    );
    answering(201, { machineId: "pc-1" });
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByText("Go back to Lanterel on your PC: it carries on by itself.");
  });

  it("a link without its key: says so, with the way back to Lanterel", () => {
    at("/pair");
    const swiff = fakeSwiff();
    render(onPairScreen(swiff));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This pairing link isn't complete: open it again from Lanterel on your PC.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to Lanterel" }));
    expect(swiff.goHome).toHaveBeenCalled();
  });
});
