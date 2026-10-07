// A friend seat's page (/seat/<token>): whose PC and whose seat, taken with
// Steam and back, its token kept out of the address bar, the Steam round trip
// and analytics, and every way a seat can no longer be taken.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutInviteTokens } from "./invite";
import { pathOf, screenAt } from "./route";
import { ScreenLang, screenLang } from "./screenCopy";
import { daysLeft, seatTokenAt, signInForSeat, takeSeat, type Seat } from "./seat";
import { SeatInvite } from "./SeatInvite";
import type { Swiff } from "./useSwiff";

const TOKEN = "abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV";
const DAY = 24 * 60 * 60_000;

type Route = [number, unknown] | (() => [number, unknown]);

/** A fetch answering each call from `routes`, by "METHOD /path" first and then by the path alone. */
function fetchFrom(routes: Record<string, Route>) {
  const calls: [string, string][] = [];
  const get = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push([method, url]);
    const route = routes[`${method} ${url}`] ?? routes[url];
    const [status, body] = typeof route === "function" ? route() : (route ?? [404, { error: "no" }]);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", get);
  return calls;
}

/** The Swiff hook as the seat page reads it. */
function fakeSwiff(over: Record<string, unknown> = {}): Swiff {
  return {
    signedIn: true,
    signInKnown: true,
    openCrew: vi.fn(),
    goHome: vi.fn(),
    ...over,
  } as unknown as Swiff;
}

/** Lena's seat for Jonas, waiting for him for 12 more days. */
function seatOf(over: Partial<Seat> = {}): Seat {
  return {
    host: "Lena",
    friend: "Jonas",
    number: 2,
    of: 3,
    state: "open",
    expiresAt: Date.now() + 12 * DAY - 60_000,
    pc: { name: "Nova-01", gpu: "Radeon RX 7900 XT", state: "ready", rentalMode: true },
    crewId: null,
    ...over,
  };
}

const at = (path: string) => history.replaceState(null, "", path);

/** Speak German, as a browser set to German does. */
function inGerman() {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
}

/** The seat screen in the language Swiff.tsx gives it. */
const onSeatScreen = (swiff: Swiff) => (
  <ScreenLang.Provider value={screenLang("seat")}>
    <SeatInvite swiff={swiff} />
  </ScreenLang.Provider>
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("seat links", () => {
  it("opens the seat screen at /seat/<token> and at /seat, back from sign-in", () => {
    expect(seatTokenAt(`/seat/${TOKEN}`)).toBe(TOKEN);
    expect(seatTokenAt("/seat")).toBe("");
    expect(seatTokenAt("/seats")).toBeNull();
    expect(screenAt(`/seat/${TOKEN}`)).toBe("seat");
    expect(screenAt("/seat/")).toBe("seat");
    expect(pathOf("seat")).toBe("/seat");
  });

  it("keeps the token out of the Steam round trip, unless storage is blocked", () => {
    expect(signInForSeat(TOKEN)).toBe("/auth/steam/login?to=%2Fseat");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(signInForSeat(TOKEN)).toBe(`/auth/steam/login?to=%2Fseat%2F${TOKEN}`);
  });

  it("cuts every seat token out of an analytics event", () => {
    const event = {
      properties: {
        $current_url: `https://lanterel.de/seat/${TOKEN}?x=1`,
        $referrer: `https://lanterel.de/auth/steam/login?to=%2Fseat%2F${TOKEN}`,
      },
    };
    expect(JSON.stringify(withoutInviteTokens(event))).not.toContain(TOKEN);
    expect(withoutInviteTokens(event).properties.$current_url).toBe("https://lanterel.de/seat?x=1");
  });

  it("names why taking a seat was refused", async () => {
    for (const [code, refused] of [
      ["taken", "taken"],
      ["expired", "expired"],
      ["own", "own"],
      ["too-many-crews", "full"],
    ]) {
      fetchFrom({ [`POST /api/seats/${TOKEN}/take`]: [409, { code }] });
      expect(await takeSeat(TOKEN)).toEqual({ refused });
    }
    fetchFrom({ [`POST /api/seats/${TOKEN}/take`]: [404, {}] });
    expect(await takeSeat(TOKEN)).toBe("invalid");
    fetchFrom({ [`POST /api/seats/${TOKEN}/take`]: [500, {}] });
    expect(await takeSeat(TOKEN)).toBeNull();
  });

  it("counts whole days left, never none while any time is", () => {
    expect(daysLeft(1000 + 14 * DAY, 1000)).toBe(14);
    expect(daysLeft(1000 + 13 * DAY + 1, 1000)).toBe(14);
    expect(daysLeft(1000 + 1, 1000)).toBe(1);
  });
});

describe("SeatInvite", () => {
  it("names whose PC and whose seat, and signs a signed-out friend in with Steam, keeping the token out", async () => {
    at(`/seat/${TOKEN}?from=wa`);
    const calls = fetchFrom({ [`/api/seats/${TOKEN}`]: [200, { seat: seatOf() }] });
    render(<SeatInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Lena saved you a seat at their gaming PC.",
    );
    expect(screen.getByText("Saved for Jonas · 12 days")).toBeInTheDocument();
    expect(screen.getByText("2 of 3, for Jonas")).toBeInTheDocument();
    expect(screen.getByText("Radeon RX 7900 XT")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lena's PC" })).toBeInTheDocument();
    expect(screen.getByText(/Lanterel OS runs on Lena's PC/)).toBeInTheDocument();
    expect(screen.getByText(/your own Steam account and your own games/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Grab your seat/ });
    expect(link).toHaveAttribute("href", "/auth/steam/login?to=%2Fseat");
    expect(location.pathname + location.search).toBe("/seat?from=wa");
    expect(sessionStorage.getItem("swiff.seat")).toBe(TOKEN);
    expect(calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("is fully German for a German browser", async () => {
    inGerman();
    at(`/seat/${TOKEN}`);
    fetchFrom({ [`/api/seats/${TOKEN}`]: [200, { seat: seatOf({ host: "Jonas", friend: "Mia" }) }] });
    render(onSeatScreen(fakeSwiff({ signedIn: false })));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Jonas hält dir einen Platz am Gaming-PC frei.",
    );
    expect(screen.getByRole("heading", { name: "Jonas' PC" })).toBeInTheDocument();
    expect(screen.getByText("Freigehalten für Mia · 12 Tage")).toBeInTheDocument();
    expect(screen.getByText("2 von 3, für Mia")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "So zockst du an Jonas' PC" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Platz annehmen/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(seat|saved|free during|Grab|Graphics|Valid)\b/);
  });

  it("leaves Lanterel OS out for a PC that is not in rental mode, and speaks plainly with no host name", async () => {
    at(`/seat/${TOKEN}`);
    fetchFrom({
      [`/api/seats/${TOKEN}`]: [
        200,
        { seat: seatOf({ host: null, pc: { ...seatOf().pc, rentalMode: false } }) },
      ],
    });
    render(<SeatInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Someone saved you a seat at their gaming PC.",
    );
    expect(screen.queryByText(/Lanterel OS/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Nova-01" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How to play on Nova-01" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  it("speaks of the gaming PC in the sentence's own case when neither its owner nor its name is known", async () => {
    inGerman();
    at(`/seat/${TOKEN}`);
    fetchFrom({
      [`/api/seats/${TOKEN}`]: [200, { seat: seatOf({ host: null, pc: { ...seatOf().pc, name: null } }) }],
    });
    render(onSeatScreen(fakeSwiff({ signedIn: false })));
    expect(await screen.findByRole("heading", { name: "Der Gaming-PC" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "So zockst du an dem Gaming-PC" })).toBeInTheDocument();
    expect(screen.getByText(/Auf dem Gaming-PC läuft Lanterel OS/)).toBeInTheDocument();
  });

  it("takes the seat for a signed-in friend with one button and opens the crew", async () => {
    at(`/seat/${TOKEN}`);
    const calls = fetchFrom({
      [`/api/seats/${TOKEN}`]: [200, { seat: seatOf() }],
      [`POST /api/seats/${TOKEN}/take`]: [
        200,
        { crewId: "c1", seat: seatOf({ state: "yours", crewId: "c1" }) },
      ],
    });
    const swiff = fakeSwiff();
    render(<SeatInvite swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: /Grab your seat/ }));
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    expect(calls.filter(([method]) => method === "POST")).toEqual([["POST", `/api/seats/${TOKEN}/take`]]);
    expect(sessionStorage.getItem("swiff.seat")).toBeNull();
  });

  it("takes the seat at once, back from Steam at /seat with the remembered token", async () => {
    sessionStorage.setItem("swiff.seat", TOKEN);
    sessionStorage.setItem("swiff.seatTake", "1");
    at("/seat");
    const calls = fetchFrom({
      [`/api/seats/${TOKEN}`]: [200, { seat: seatOf() }],
      [`POST /api/seats/${TOKEN}/take`]: [
        200,
        { crewId: "c1", seat: seatOf({ state: "yours", crewId: "c1" }) },
      ],
    });
    const swiff = fakeSwiff({ signInKnown: false, signedIn: false });
    const { rerender } = render(<SeatInvite swiff={swiff} />);
    await screen.findByRole("heading", { level: 1 });
    expect(calls.some(([method]) => method === "POST")).toBe(false);
    const signedIn = fakeSwiff({ openCrew: swiff.openCrew });
    rerender(<SeatInvite swiff={signedIn} />);
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("shows a seat already theirs with the way to the crew, and never offers it again", async () => {
    at(`/seat/${TOKEN}`);
    fetchFrom({ [`/api/seats/${TOKEN}`]: [200, { seat: seatOf({ state: "yours", crewId: "c1" }) }] });
    const swiff = fakeSwiff();
    render(<SeatInvite swiff={swiff} />);
    expect(await screen.findByRole("status")).toHaveTextContent("This seat is yours.");
    expect(screen.getByText("Your seat, Jonas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Grab your seat/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Go to the crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("c1");
  });

  it("tells the host it is their own PC's seat, someone else that it is taken, and anyone that it ran out", async () => {
    at(`/seat/${TOKEN}`);
    let seat = seatOf({ state: "host" });
    fetchFrom({ [`/api/seats/${TOKEN}`]: () => [200, { seat }] });
    const { unmount } = render(<SeatInvite swiff={fakeSwiff()} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This is a seat at your own PC. Send the link to Jonas.",
    );
    expect(screen.queryByRole("button", { name: /Grab your seat/ })).toBeNull();
    unmount();

    seat = seatOf({ state: "host", expiresAt: Date.now() - 1 });
    const ran = render(<SeatInvite swiff={fakeSwiff()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("This seat waited 14 days and has expired.");
    expect(screen.getByText("This seat has expired")).toBeInTheDocument();
    ran.unmount();

    seat = seatOf({ state: "taken" });
    const taken = render(<SeatInvite swiff={fakeSwiff()} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Someone else already has this seat. Ask Lena for another one.",
    );
    taken.unmount();

    seat = seatOf({ state: "expired" });
    render(<SeatInvite swiff={fakeSwiff()} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This seat waited 14 days and has expired. Ask Lena for a new link.",
    );
    expect(screen.getByText("This seat has expired")).toBeInTheDocument();
  });

  it("says why taking it was refused, and shows the seat as it is now", async () => {
    at(`/seat/${TOKEN}`);
    let seat = seatOf();
    fetchFrom({
      [`/api/seats/${TOKEN}`]: () => [200, { seat }],
      [`POST /api/seats/${TOKEN}/take`]: () => {
        seat = seatOf({ state: "taken" });
        return [409, { code: "taken" }];
      },
    });
    const swiff = fakeSwiff();
    render(<SeatInvite swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: /Grab your seat/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else already has this seat.");
    expect(await screen.findByText("This seat is taken")).toBeInTheDocument();
    expect(swiff.openCrew).not.toHaveBeenCalled();
  });

  it("says why a friend in as many crews as anyone may be cannot take it", async () => {
    at(`/seat/${TOKEN}`);
    fetchFrom({
      [`/api/seats/${TOKEN}`]: [200, { seat: seatOf() }],
      [`POST /api/seats/${TOKEN}/take`]: [409, { code: "too-many-crews" }],
    });
    render(<SeatInvite swiff={fakeSwiff()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Grab your seat/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Leave one to start or join another.");
  });

  it("says a dead link opens nothing, and lets an unanswered one be tried again", async () => {
    at(`/seat/${TOKEN}`);
    let answer: [number, unknown] = [503, {}];
    fetchFrom({ [`/api/seats/${TOKEN}`]: () => answer });
    const swiff = fakeSwiff();
    render(<SeatInvite swiff={swiff} />);
    expect(await screen.findByRole("heading", { name: "The seat couldn't be opened." })).toBeInTheDocument();
    answer = [404, {}];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "This seat link doesn't work any more." }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the start" }));
    expect(swiff.goHome).toHaveBeenCalled();
  });

  it("opens nothing with no token at all", () => {
    at("/seat");
    fetchFrom({});
    render(<SeatInvite swiff={fakeSwiff()} />);
    expect(
      screen.getByRole("heading", { name: "This seat link doesn't work any more." }),
    ).toBeInTheDocument();
  });
});
