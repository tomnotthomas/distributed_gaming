// Crews on the page: founding one in a tap, the crews a player is in, one
// crew's lobby, the invite page a crew's link opens, and the ways into crews
// from the rest of the app (the card, the wall's strip, the ready banner).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREW_COPY, crewText, langOf, possessive } from "./crewCopy";
import { CrewInvite } from "./CrewInvite";
import { CrewPage } from "./CrewPage";
import {
  crewRouteAt,
  crewTitle,
  inviteMessage,
  nudgeMessage,
  pcTitle,
  sessionCalendar,
  sessionClock,
  sessionDay,
  sessionWhen,
  zoned,
  zonedAt,
  type CrewDetail,
  type CrewMember,
  type MyCrew,
} from "./crews";
import { CrewReadyBanner, CrewStrip, CrewsCard } from "./CrewsCard";
import { GAMES } from "./data";
import { inviteLink, inviteTokenAt, shareTarget, signInForInvite, withoutInviteTokens } from "./invite";
import { pathOf, screenAt } from "./route";
import { ScreenLang } from "./screenCopy";
import type { Swiff } from "./useSwiff";

const TOKEN = "abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV";
const NEW_TOKEN = "zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ";

type Route = [number, unknown] | (() => [number, unknown]);

/**
 * A fetch answering each call from `routes`, by "METHOD /path" first and then
 * by the path alone: a status and a JSON body. Every call is kept, with its body.
 */
function fetchFrom(routes: Record<string, Route>) {
  const calls: [string, string, string?][] = [];
  const get = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(init?.body === undefined ? [method, url] : [method, url, String(init.body)]);
    const route = routes[`${method} ${url}`] ?? routes[url];
    const [status, body] = typeof route === "function" ? route() : (route ?? [404, { error: "no" }]);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", get);
  return calls;
}

/** The Swiff hook as the crew screens read it. */
function fakeSwiff(over: Record<string, unknown> = {}): Swiff {
  return {
    signedIn: true,
    signInKnown: true,
    screen: "crew",
    crewRoute: { crew: null },
    crewChanges: 0,
    crewReady: null,
    dismissCrewReady: vi.fn(),
    openCrew: vi.fn(),
    replaceCrew: vi.fn(),
    goHome: vi.fn(),
    goStart: vi.fn(),
    foundCrew: vi.fn(),
    inviteShared: vi.fn(),
    games: [],
    spots: new Map(),
    crewLive: [],
    playOn: vi.fn(),
    watch: vi.fn(),
    phase: "idle",
    taken: null,
    bookingFailed: false,
    ...over,
  } as unknown as Swiff;
}

const atCrew = (id: string, over: Record<string, unknown> = {}) =>
  fakeSwiff({ crewRoute: { crew: id }, ...over });

const LENA: CrewMember = {
  id: "m-lena",
  name: "Lena",
  you: true,
  admin: true,
  pc: null,
  pcs: 0,
  rsvp: null,
  next: null,
};
const SAM: CrewMember = { ...LENA, id: "m-sam", name: "Sam", you: false, admin: false };
const MAX: CrewMember = { ...LENA, id: "m-max", name: "Max", you: false, admin: false, pc: "yes", pcs: 1 };

/** Lena's crew as she, its founder, sees it right after founding it. */
function crewOf(over: Partial<CrewDetail> = {}): CrewDetail {
  return {
    id: "c1",
    memberId: "m-lena",
    name: "Lena",
    crewName: null,
    own: true,
    size: 1,
    state: "no-pc",
    pcs: 0,
    session: null,
    token: TOKEN,
    members: [LENA],
    machines: [],
    shared: false,
    busy: [],
    picks: 0,
    offered: 0,
    ...over,
  };
}

/** Lena's crew as Sam sees it, having just joined from her link. */
function joinedCrew(sam: Partial<CrewMember> = {}, over: Partial<CrewDetail> = {}): CrewDetail {
  return crewOf({
    memberId: "m-sam",
    own: false,
    size: 2,
    members: [
      { ...LENA, you: false },
      { ...SAM, you: true, ...sam },
    ],
    ...over,
  });
}

/** Lena's crew once Max's PC plays for it. */
function readyCrew(over: Partial<CrewDetail> = {}): CrewDetail {
  return crewOf({
    size: 2,
    state: "ready",
    pcs: 1,
    members: [LENA, MAX],
    machines: [
      {
        id: "q-max",
        name: "DESKTOP-7Q",
        owner: "Max",
        mine: false,
        state: "ready",
        games: [GAMES[0]!.appid, GAMES[1]!.appid],
        playing: null,
      },
    ],
    offered: 2,
    ...over,
  });
}

/** Stub the phone's share sheet (afterEach takes it away again); returns its mock. */
function stubShareSheet() {
  const share = vi.fn(async (_data: ShareData) => {});
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  return share;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { clipboard?: unknown }).clipboard;
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("crew copy", () => {
  const en = CREW_COPY.en as Record<string, string>;
  const de = CREW_COPY.de as Record<string, string>;

  it("has every key in German and English, with the same slots in both", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en)) expect([key, slots(de[key]!)]).toEqual([key, slots(en[key]!)]);
  });

  it("fills its slots and leaves an unfilled one as it is", () => {
    expect(crewText("en")("cp.peopleIn", { n: 3 })).toBe("3 in");
    expect(crewText("de")("crews.people", { n: 4 })).toBe("4 Leute");
    expect(crewText("en")("leave.title")).toBe("Leave {crew}?");
  });

  it("never sets a long dash", () => {
    for (const text of [...Object.values(en), ...Object.values(de)]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it("puts German possessives as German does: Max' Crew, but Lenas Crew", () => {
    expect(possessive("de", "crew.of", "Max")).toBe("Max' Crew");
    expect(possessive("de", "crew.of", "Jonas")).toBe("Jonas' Crew");
    expect(possessive("de", "crew.of", "Lena")).toBe("Lenas Crew");
    expect(possessive("de", "pc.of", "Fritz")).toBe("Fritz' PC");
    expect(possessive("en", "crew.of", "Max")).toBe("Max's crew");
    expect(possessive("en", "pc.of", "Lena")).toBe("Lena's PC");
  });

  it("speaks German to a browser set to German, English to the rest", () => {
    expect(langOf(["de-AT", "en"])).toBe("de");
    expect(langOf(["en-GB", "de"])).toBe("de");
    expect(langOf(["fr-FR"])).toBe("en");
    expect(langOf(["deu"])).toBe("en");
  });
});

describe("crew addresses and names", () => {
  it("says a Zockrunde's day and time in Berlin's, wherever the browser is, across the clock change", () => {
    // Sunday 25 October 2026 the clocks go back: 21:00 is UTC+1 then, 19:00 UTC the Friday before.
    expect(zonedAt(2026, 9, 25, 21)).toBe(Date.UTC(2026, 9, 25, 20));
    expect(zonedAt(2026, 9, 9, 21)).toBe(Date.UTC(2026, 9, 9, 19));
    expect(zoned(Date.UTC(2026, 9, 9, 23))).toMatchObject({
      year: 2026,
      month: 9,
      day: 10,
      hour: 1,
      weekday: 6,
    });
    const at = Date.UTC(2026, 9, 9, 19, 30);
    expect(sessionWhen("de", at)).toBe("Freitag, 9. Oktober, 21:30 Uhr");
    expect(sessionWhen("en", at)).toBe("Friday 9 October, 9:30 pm");
    expect(sessionDay("de", at)).toBe("Fr 9. Okt");
    expect(sessionClock(at)).toBe("21:30");
  });

  it("reads /crews and /crews/<id>, and opens the crew screen there", () => {
    expect(crewRouteAt("/crews")).toEqual({ crew: null });
    expect(crewRouteAt("/crews/")).toEqual({ crew: null });
    expect(crewRouteAt("/crews/c-42")).toEqual({ crew: "c-42" });
    expect(crewRouteAt("/crewsy")).toBeNull();
    expect(crewRouteAt("/crews/a/b")).toBeNull();
    expect(screenAt("/crews")).toBe("crew");
    expect(screenAt("/crews/c-42/")).toBe("crew");
    expect(screenAt("/crewsy")).toBe("home");
    expect(pathOf("crew")).toBe("/crews");
    expect(screenAt(pathOf("crew"))).toBe("crew");
  });

  it("calls a crew by its own name, else whose it is, else plainly", () => {
    expect(crewTitle("en", { name: "Lena", crewName: "Friday Squad", own: true })).toBe("Friday Squad");
    expect(crewTitle("en", { name: "Lena", crewName: null, own: false })).toBe("Lena's crew");
    expect(crewTitle("de", { name: "Max", crewName: null, own: false })).toBe("Max' Crew");
    expect(crewTitle("en", { name: null, crewName: null, own: true })).toBe("Your crew");
    expect(crewTitle("de", { name: null, crewName: null, own: false })).toBe("Die Crew");
  });

  it("calls a PC by its owner, else its own name, else plainly", () => {
    expect(pcTitle("en", { owner: "Max", name: "DESKTOP-7Q" })).toBe("Max's PC");
    expect(pcTitle("de", { owner: "Max", name: null })).toBe("Max' PC");
    expect(pcTitle("en", { owner: null, name: "DESKTOP-7Q" })).toBe("DESKTOP-7Q");
    expect(pcTitle("de", { owner: null, name: null })).toBe("Ein Gaming-PC");
  });

  it("asks who has a gaming PC while none is in, and only invites once one is", () => {
    const origin = "https://lanterel.example";
    const link = `${origin}/invite/${TOKEN}`;
    const founder = inviteMessage("en", crewOf(), origin);
    expect(founder).toContain("I set up a crew for us: Lena's crew");
    expect(founder).toContain("who's got a gaming PC?");
    expect(founder.endsWith(link)).toBe(true);
    expect(inviteMessage("en", joinedCrew(), origin)).toMatch(
      /^Come join our crew: .*Who's got a gaming PC\?/,
    );
    const ready = inviteMessage("en", readyCrew(), origin);
    expect(ready).not.toMatch(/gaming PC\?/);
    expect(ready).toContain(link);
    expect(inviteMessage("de", crewOf({ name: "Max" }), origin)).toContain("Max' Crew");
    expect(inviteMessage("en", crewOf({ token: null }), origin)).toMatch(/ https:\/\/lanterel\.example$/);
  });

  it("puts the Zockrunde's date in the message only until 6 hours after it starts", () => {
    const origin = "https://lanterel.example";
    const at = Date.UTC(2026, 9, 9, 19); // Friday 9 October, 21:00 in Berlin
    const crew = crewOf({ session: { at, yes: 1, no: 0 } });
    expect(inviteMessage("en", crew, origin, at + 6 * 3600_000 - 1)).toMatch(
      /^Session on Friday 9 October, 9 pm/,
    );
    const over = inviteMessage("en", crew, origin, at + 6 * 3600_000);
    expect(over).not.toMatch(/Session on|October/);
    expect(over).toBe(inviteMessage("en", crewOf(), origin));
  });
});

describe("invite links", () => {
  it("opens the invite screen at /invite/<token> and coming back from sign-in at /invite", () => {
    expect(screenAt(`/invite/${TOKEN}`)).toBe("invite");
    expect(screenAt("/invite")).toBe("invite");
    expect(screenAt("/invitee")).toBe("home");
    expect(inviteTokenAt(`/invite/${TOKEN}/`)).toBe(TOKEN);
    expect(inviteTokenAt("/invite")).toBe("");
    expect(inviteTokenAt("/share")).toBeNull();
    expect(screenAt(pathOf("invite"))).toBe("invite");
    expect(inviteLink(TOKEN, "https://lanterel.example")).toBe(`https://lanterel.example/invite/${TOKEN}`);
  });

  it("keeps the token out of the Steam round trip, remembering it in the tab", () => {
    expect(signInForInvite(TOKEN)).toBe("/auth/steam/login?to=%2Finvite");
    expect(sessionStorage.getItem("swiff.invite")).toBe(TOKEN);
  });

  it("brings the token back in the path only when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(signInForInvite(TOKEN)).toBe(`/auth/steam/login?to=%2Finvite%2F${TOKEN}`);
  });

  it("cuts every invite token out of an analytics event, wherever it sits", () => {
    const timestamp = new Date(0);
    const event = {
      uuid: "u",
      event: "$autocapture",
      timestamp,
      properties: {
        $current_url: `https://lanterel.example/invite/${TOKEN}?ref=wa`,
        $pathname: `/invite/${TOKEN}/`,
        $referrer: `https://lanterel.example/invite/${TOKEN}`,
        $elements: [{ tag_name: "a", attr__href: `/auth/steam/login?to=%2Finvite%2F${TOKEN}` }],
        $elements_chain: `a:href="/invite/${TOKEN}"`,
        $screen_height: 900,
      },
      $set_once: { $initial_current_url: `https://lanterel.example/invite/${TOKEN}` },
      $set: { $session_entry_url: `https://lanterel.example/invite/${TOKEN}`, $other: "/invitee/x" },
    };
    const sent = withoutInviteTokens(event);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect(sent.properties.$current_url).toBe("https://lanterel.example/invite?ref=wa");
    expect(sent.properties.$pathname).toBe("/invite/");
    expect(sent.properties.$elements[0]!.attr__href).toBe("/auth/steam/login?to=%2Finvite");
    expect(sent.$set_once.$initial_current_url).toBe("https://lanterel.example/invite");
    expect(sent.$set.$other).toBe("/invitee/x");
    expect(sent.properties.$screen_height).toBe(900);
    expect(sent.timestamp).toBe(timestamp);
  });

  it("sends WhatsApp and Telegram the message, and copies it for Discord and Signal", () => {
    const link = `https://lanterel.example/invite/${TOKEN}`;
    expect(shareTarget("whatsapp", "play & win", link)).toEqual({
      open: "https://wa.me/?text=play%20%26%20win",
    });
    expect(shareTarget("telegram", `Come join ${link}`, link)).toEqual({
      open: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=Come%20join`,
    });
    expect(shareTarget("discord", "m", link)).toEqual({ copy: "m" });
    expect(shareTarget("signal", "m", link)).toEqual({ copy: "m" });
  });
});

describe("CrewPage: signed out, founding and the list", () => {
  it("waits for sign-in to be known before reading anything", () => {
    const calls = fetchFrom({});
    render(<CrewPage swiff={fakeSwiff({ signInKnown: false, signedIn: false })} />);
    expect(screen.getByText("Loading your crew…")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("offers a signed-out visitor Start a crew, through Steam and back to founding it", () => {
    const calls = fetchFrom({});
    render(<CrewPage swiff={fakeSwiff({ signedIn: false })} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Start your crew");
    expect(screen.getByRole("link", { name: /Start a crew/ })).toHaveAttribute(
      "href",
      "/auth/steam/login?to=%2Fcrews%3Ffound%3D1",
    );
    expect(screen.getByText("Sign in with Steam first. No password, no new account.")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("founds the crew once, right on the list, and puts its id in the address: no page of its own", async () => {
    const calls = fetchFrom({
      "GET /api/crews": [200, { crews: [] }],
      "POST /api/crews": [201, { crew: crewOf({ id: "c-new" }) }],
    });
    const swiff = fakeSwiff();
    render(
      <StrictMode>
        <CrewPage swiff={swiff} />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Start a crew/ }));
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(calls.filter(([method]) => method === "POST")).toEqual([["POST", "/api/crews", "{}"]]);
    expect(swiff.replaceCrew).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Starting your crew/)).toBeNull();
  });

  it("says so when the crew could not be founded, and tries again", async () => {
    let answer: [number, unknown] = [500, {}];
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [] }], "POST /api/crews": () => answer });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start a crew/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your crew couldn't be started. Try again.");
    answer = [201, { crew: crewOf({ id: "c-new" }) }];
    fireEvent.click(screen.getByRole("button", { name: /Start a crew/ }));
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(2);
  });

  it("says why when the player is in as many crews as anyone may be", async () => {
    const calls = fetchFrom({
      "GET /api/crews": [200, { crews: [crewOf(), crewOf({ id: "c2" })] }],
      "POST /api/crews": [409, { code: "too-many-crews" }],
    });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start a new crew/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You're in 50 crews already");
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("lists the crews a player is in, each opening its page, and founds another", async () => {
    const crews: MyCrew[] = [
      { ...crewOf(), size: 1 },
      { ...readyCrew({ id: "c2", name: "Max", own: false, memberId: "m-lena-2" }), size: 3 },
    ];
    fetchFrom({ "GET /api/crews": [200, { crews }] });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Your crews");
    const lena = screen.getByRole("button", { name: /Lena's crew/ });
    expect(lena).toHaveTextContent("1 person · Almost ready.");
    expect(screen.getByRole("button", { name: /Max's crew/ })).toHaveTextContent("3 people · Ready to play!");
    fireEvent.click(lena);
    expect(swiff.openCrew).toHaveBeenCalledWith("c1");
    expect(screen.getByRole("button", { name: /Start a new crew/ })).toBeEnabled();
    expect(swiff.replaceCrew).not.toHaveBeenCalled();
  });

  it("goes straight to the one crew a player is in", async () => {
    fetchFrom({ "GET /api/crews": [200, { crews: [crewOf()] }] });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c1"));
  });

  it("offers founding to a player in no crew, and retries a list that could not be read", async () => {
    let answer: [number, unknown] = [500, {}];
    fetchFrom({ "GET /api/crews": () => answer });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your crews couldn't be loaded.");
    answer = [200, { crews: [] }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /Start a crew/ })).toBeEnabled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Start your crew");
  });
});

describe("CrewPage: the guided crew page", () => {
  // Wednesday 7 October 2026, noon: the days on offer run Today to Sunday 11.
  const NOON = new Date(Date.UTC(2026, 9, 7, 10)); // 12:00 in Berlin
  const FRIDAY_9PM = Date.UTC(2026, 9, 9, 19); // 21:00 in Berlin
  const dated = { at: FRIDAY_9PM, yes: 1, no: 0 };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  });
  afterEach(() => vi.useRealTimers());

  /** The ticket's coupons, each as "label:state". */
  const stubs = () =>
    screen
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("gc-stub"))
      .map((li) => `${li.querySelector(".gc-t")!.textContent}:${li.className.split(" ").pop()}`);

  it("asks the founder for the date first, on Friday at 9 pm unless they pick another", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "POST /api/crews/c1/session": [200, { crew: crewOf({ session: dated }) }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Pick a day in the calendar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lena's crew");
    expect(screen.getByText("no date yet")).toBeInTheDocument();
    expect(stubs()).toEqual([
      "Date:now",
      "Get your people:later",
      "Gaming PC:later",
      "Pick games:later",
      "Play:later",
    ]);
    // Nothing else competes: no PC card, no share block, no "later".
    expect(screen.queryByRole("button", { name: /WhatsApp/ })).toBeNull();
    expect(screen.queryByText(/later/i, { selector: "button" })).toBeNull();

    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fri 9 Oct" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Time on Fri 9 Oct" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sat 10 Oct" }));
    fireEvent.click(screen.getByRole("button", { name: "20:00" }));
    expect(screen.getByRole("button", { name: /Set Sat 10 Oct, 8 pm/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fri 9 Oct" }));
    fireEvent.click(screen.getByRole("button", { name: "21:00" }));
    fireEvent.click(screen.getByRole("button", { name: /Set Fri 9 Oct, 9 pm/ }));
    expect(await screen.findByRole("heading", { name: "Now get your people in" })).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/session", JSON.stringify({ at: FRIDAY_9PM })]);
    expect(stubs()).toEqual([
      "Date:done",
      "Get your people:now",
      "Gaming PC:later",
      "Pick games:later",
      "Play:later",
    ]);
    expect(screen.getByText("Fri 9 Oct, 9 pm")).toBeInTheDocument();
    expect(screen.getByText("Only you so far")).toBeInTheDocument();
  });

  it("turns the months up to the server's 90 days ahead, never back past today", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("button", { name: "Previous month" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tue 6 Oct" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wed 7 Oct" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(screen.getByRole("button", { name: "Thu 24 Dec" }));
    expect(screen.getByRole("button", { name: /^Set Thu 24 Dec, 9 pm/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("January 2027")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mon 4 Jan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tue 5 Jan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled();
  });

  it("marks the days the gaming PC already plays for another crew, and says whose it is", async () => {
    const saturday = Date.UTC(2026, 9, 10, 18); // 20:00 in Berlin
    const later = Date.UTC(2026, 9, 17, 18);
    fetchFrom({
      "GET /api/crews/c1": [
        200,
        {
          crew: readyCrew({
            busy: [
              { at: saturday, owner: "Max" },
              { at: later, owner: "Max" },
            ],
          }),
        },
      ],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(
      await screen.findByRole("button", { name: "Sat 10 Oct, gaming PC already booked" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sat 17 Oct, gaming PC already booked" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fri 9 Oct" })).toBeInTheDocument();
    expect(screen.getByText(/the gaming PC is already booked for another session/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sat 10 and Sat 17: Max's PC already plays for another crew from 8 pm. On those days, pick an earlier time or ask Max.",
      ),
    ).toBeInTheDocument();
  });

  it("never sets a time that has gone by while the page stood open", async () => {
    const calls = fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 18, 30))); // 20:30 in Berlin
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Wed 7 Oct" }));
    const set = screen.getByRole("button", { name: /^Set Wed 7 Oct, 9 pm/ });
    expect(set).toBeEnabled();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 19, 5))); // 21:05: the hour has begun
    fireEvent.click(set);
    expect(set).toBeDisabled();
    expect(calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("asks in German too, and never lets a time already gone today be set", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 19, 30))); // 21:30 in Berlin
    render(
      <ScreenLang.Provider value="de">
        <CrewPage swiff={atCrew("c1")} />
      </ScreenLang.Provider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Such dir einen Tag im Kalender aus" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Oktober 2026")).toBeInTheDocument();
    // Friday 9 pm has gone: tomorrow is picked, and today keeps only a later hour.
    expect(screen.getByRole("button", { name: "Sa 10. Okt" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Fr 9. Okt" }));
    expect(screen.getByRole("button", { name: /Fr 9\. Okt, 21 Uhr festlegen/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "22:00" }));
    expect(screen.getByRole("button", { name: /Fr 9\. Okt, 22 Uhr festlegen/ })).toBeEnabled();
  });

  it("sends the date on WhatsApp with who asks and who has a gaming PC, and marks the step done", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf({ session: dated }) }],
      "POST /api/crews/c1/shared": [200, { crew: crewOf({ session: dated, shared: true }) }],
    });
    const share = stubShareSheet();
    render(<CrewPage swiff={atCrew("c1")} />);
    const preview = await screen.findByText(/^Session on Friday 9 October, 9 pm 🎮/);
    expect(preview).toHaveTextContent("Lena is inviting you to the crew. Tap to say yes or no:");
    fireEvent.click(screen.getByRole("button", { name: "Send on WhatsApp" }));
    expect(await screen.findByRole("heading", { name: "Who brings the gaming PC?" })).toBeInTheDocument();
    const text = share.mock.calls[0]![0].text!;
    expect(text.split("\n")).toEqual([
      "Session on Friday 9 October, 9 pm 🎮",
      "Lena is inviting you to the crew. Tap to say yes or no:",
      `${location.origin}/invite/${TOKEN}`,
      "Who's got a gaming PC? One is enough for all of us.",
    ]);
    expect(calls).toContainEqual(["POST", "/api/crews/c1/shared"]);
    expect(stubs()).toEqual([
      "Date:done",
      "Get your people:done",
      "Gaming PC:now",
      "Pick games:later",
      "Play:later",
    ]);
  });

  it("leaves the step open when the crew link could not be copied", async () => {
    const calls = fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf({ session: dated }) }] });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Copy the crew link" }))[0]!);
    expect(
      await screen.findByText("Couldn't copy. Select the link and copy it yourself."),
    ).toBeInTheDocument();
    expect(calls).not.toContainEqual(["POST", "/api/crews/c1/shared"]);
    expect(stubs()).toEqual([
      "Date:done",
      "Get your people:now",
      "Gaming PC:later",
      "Pick games:later",
      "Play:later",
    ]);
  });

  it("brings the founder's PC with one button, or asks the group", async () => {
    const shared = crewOf({ session: dated, shared: true });
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: shared }],
      "POST /api/crews/c1/pc": [200, { crew: { ...shared, members: [{ ...LENA, pc: "yes" }] } }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: /Yes: put the app on my PC/ }));
    expect(
      await screen.findByRole("heading", { name: "Almost there: set up your gaming PC" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/pc", '{"pc":"yes"}']);
  });

  it("opens a done step again to change it: the date moves, and everyone is asked again", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf({ session: dated, shared: true }) }],
      "POST /api/crews/c1/session": [
        200,
        { crew: crewOf({ session: { ...dated, at: FRIDAY_9PM + 3600_000 } }) },
      ],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change: Date" }));
    expect(screen.getByRole("heading", { name: "Move the date" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "21:00" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "22:00" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to Fri 9 Oct, 10 pm/ }));
    expect(await screen.findByRole("heading", { name: "Now get your people in" })).toBeInTheDocument();
    expect(calls).toContainEqual([
      "POST",
      "/api/crews/c1/session",
      JSON.stringify({ at: FRIDAY_9PM + 3600_000 }),
    ]);
  });

  it("asks someone who joined to say yes or no, and shows everyone's answer", async () => {
    const crew = joinedCrew(
      {},
      {
        session: dated,
        members: [
          { ...LENA, you: false, rsvp: "yes" },
          { ...SAM, you: true },
        ],
      },
    );
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew }],
      "POST /api/crews/c1/rsvp": [
        200,
        {
          crew: {
            ...crew,
            session: { ...dated, yes: 2 },
            members: [crew.members[0], { ...crew.members[1], rsvp: "yes" }],
          },
        },
      ],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Are you in on Friday at 9 pm?" })).toBeInTheDocument();
    expect(screen.getByText("Lena invited you")).toBeInTheDocument();
    expect(screen.getByText("Lena set the date. Tell the crew whether you're coming.")).toBeInTheDocument();
    expect(stubs()).toEqual(["Say yes or no:now", "Gaming PC:later", "Pick games:later", "Play:later"]);
    expect(screen.getByRole("heading", { name: "Who's coming on Friday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No answer yet 1" }).parentElement).toHaveTextContent(
      "Sam (you)",
    );
    expect(screen.getByRole("heading", { name: "In 1" }).parentElement).toHaveTextContent("Lena");
    expect(screen.getByText("1 in")).toBeInTheDocument();
    expect(screen.getByText("1 haven't answered")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "I'm in" }));
    expect(await screen.findByRole("heading", { name: "Who brings the gaming PC?" })).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/rsvp", '{"rsvp":"yes"}']);
    expect(screen.getByText("2 in")).toBeInTheDocument();
    expect(stubs()).toEqual(["Say yes or no:done", "Gaming PC:now", "Pick games:later", "Play:later"]);
  });

  it("goes past answering while there is no date, and gives no rename or new link to a member", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: joinedCrew() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Who brings the gaming PC?" })).toBeInTheDocument();
    expect(stubs()).toEqual(["Say yes or no:later", "Gaming PC:now", "Pick games:later", "Play:later"]);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make a new link" })).toBeNull();
  });

  it("asks the group for a PC, then waits for one, with a way back to bringing one", async () => {
    const crew = joinedCrew({}, { session: dated });
    const calls = fetchFrom({
      "GET /api/crews/c1": [
        200,
        { crew: { ...crew, members: [crew.members[0], { ...crew.members[1], rsvp: "no" }] } },
      ],
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "No: ask the group" }));
    expect(await screen.findByRole("heading", { name: "A gaming PC is still missing" })).toBeInTheDocument();
    expect(String(open.mock.calls[0]![0])).toMatch(/^https:\/\/wa\.me\/\?text=/);
    // Asking puts nothing off on the server: there is no "later" to send.
    expect(calls.filter(([method]) => method === "POST")).toEqual([]);
    expect(screen.getByRole("button", { name: "I've got one after all" })).toBeInTheDocument();
  });

  // Three of the player's games, two of them installed on Max's PC.
  const [ER, CS] = [GAMES[0]!, GAMES[1]!];
  const library = { games: [ER, CS, GAMES[2]!] };

  it("starts the game the player picks on the crew's free PC: first come, first play", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: readyCrew({ session: dated, shared: true, picks: 2 }) }],
    });
    const swiff = atCrew("c1", library);
    render(<CrewPage swiff={swiff} />);
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(stubs()).toEqual([
      "Date:done",
      "Get your people:done",
      "Gaming PC:done",
      "Pick games:done",
      "Play:now",
    ]);
    expect(screen.getByText("2 games")).toBeInTheDocument();
    expect(screen.getByText("Your games that run on Max's PC")).toBeInTheDocument();
    // Only games installed on the PC are offered, the most played first, and it is picked.
    const tiles = screen
      .getAllByRole("button", { pressed: false })
      .concat(screen.getAllByRole("button", { pressed: true }));
    expect(tiles.map((b) => b.textContent).sort()).toEqual([CS.title, ER.title].sort());
    expect(screen.getByRole("button", { name: CS.title })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("You scan a QR code once with the Steam app. Max doesn't have to do anything."),
    ).toBeInTheDocument();
    expect(screen.getByText("Max's PC is on. It plays for this crew only.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ER.title }));
    fireEvent.click(screen.getByRole("button", { name: `Start ${ER.title}` }));
    expect(swiff.playOn).toHaveBeenCalledWith(ER, "q-max");
  });

  it("says when someone was quicker to start", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: readyCrew({ session: dated, shared: true, picks: 1 }) }],
    });
    const swiff = atCrew("c1", library);
    const { rerender } = render(<CrewPage swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: `Start ${CS.title}` }));
    rerender(<CrewPage swiff={{ ...swiff, taken: { nextBest: null } } as Swiff} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("someone else just started");
  });

  it("lets the others watch whoever plays, or get in line to go next", async () => {
    const playing = {
      sessionId: "s1",
      player: "Max",
      you: false,
      gameId: ER.appid,
      startedAt: NOON.getTime() - 24 * 60_000,
      starting: false,
    };
    const busy = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      machines: [{ ...readyCrew().machines[0]!, state: "busy", playing }],
    });
    const queued = {
      ...busy,
      members: [{ ...LENA, next: { gameId: CS.appid, at: 5 } }, { ...MAX }],
    };
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: busy }],
      "POST /api/crews/c1/next": [200, { crew: queued }],
    });
    const entry = { sessionId: "s1", starting: false, player: "Max", gameId: ER.appid, watching: 2 };
    const swiff = atCrew("c1", { ...library, crewLive: [entry] });
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("heading", { name: `Max is playing ${ER.title}` })).toBeInTheDocument();
    expect(screen.getByText("On now")).toBeInTheDocument();
    expect(screen.getByText("for 24 min")).toBeInTheDocument();
    expect(screen.getByText("2 watching")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Watch/ }));
    expect(swiff.watch).toHaveBeenCalledWith(entry);

    fireEvent.click(screen.getByRole("button", { name: /I want to go next/ }));
    await screen.findByText("Who's next");
    expect(calls).toContainEqual(["POST", "/api/crews/c1/next", `{"gameId":${CS.appid}}`]);
    expect(screen.getByText("When Max stops, whoever is first in line goes next.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave the line" })).toBeInTheDocument();
    expect(screen.getByText("What do you want to play?")).toBeInTheDocument();
  });

  it("offers a free PC while someone plays on another, with the games installed on it", async () => {
    const playing = {
      sessionId: "s1",
      player: "Max",
      you: false,
      gameId: ER.appid,
      startedAt: 1,
      starting: false,
    };
    const [max] = readyCrew().machines;
    const crew = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      pcs: 2,
      machines: [
        { ...max!, state: "busy", playing },
        {
          id: "q-sam",
          name: null,
          owner: "Sam",
          mine: false,
          state: "ready",
          games: [ER.appid],
          playing: null,
        },
      ],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const swiff = atCrew("c1", library);
    render(<CrewPage swiff={swiff} />);
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CS.title })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Start ${ER.title}` }));
    expect(swiff.playOn).toHaveBeenCalledWith(ER, "q-sam");
  });

  it("tells the owner their free PC is for the crew, without a start they cannot make", async () => {
    const [max] = readyCrew().machines;
    const crew = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      machines: [{ ...max!, owner: "Lena", mine: true }],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const swiff = atCrew("c1", library);
    render(<CrewPage swiff={swiff} />);
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Your PC is free; your crew can start on it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
  });

  it("lets the owner watch their own PC but not get in line for it", async () => {
    const playing = {
      sessionId: "s1",
      player: "Max",
      you: false,
      gameId: ER.appid,
      startedAt: 1,
      starting: false,
    };
    const [max] = readyCrew().machines;
    const own = { ...max!, owner: "Lena", mine: true, state: "busy" as const, playing };
    const entry = { sessionId: "s1", starting: false, player: "Max", gameId: ER.appid, watching: 0 };
    let crew = readyCrew({ session: dated, shared: true, picks: 1, machines: [own] });
    fetchFrom({ "GET /api/crews/c1": () => [200, { crew }] });
    const swiff = atCrew("c1", { ...library, crewLive: [entry] });
    const { rerender } = render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("heading", { name: `Max is playing ${ER.title}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Watch/ }));
    expect(swiff.watch).toHaveBeenCalledWith(entry);
    expect(screen.queryByRole("button", { name: /I want to go next/ })).toBeNull();

    crew = { ...crew, members: [{ ...LENA, next: { gameId: CS.appid, at: 5 } }, MAX] };
    rerender(<CrewPage swiff={{ ...swiff, crewChanges: 1 }} />);
    expect(await screen.findByRole("button", { name: "Leave the line" })).toBeInTheDocument();
    expect(screen.queryByText("What do you want to play?")).toBeNull();
  });

  it("offers the owner another free PC before their own", async () => {
    const [max] = readyCrew().machines;
    const crew = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      pcs: 2,
      machines: [
        { ...max!, id: "q-lena", owner: "Lena", mine: true },
        { ...max!, games: [ER.appid] },
      ],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const swiff = atCrew("c1", library);
    render(<CrewPage swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: `Start ${ER.title}` }));
    expect(swiff.playOn).toHaveBeenCalledWith(ER, "q-max");
    expect(screen.queryByText("Your PC is free; your crew can start on it.")).toBeNull();
  });

  it("does not call a PC free while someone's start on it is still on its way", async () => {
    const [max] = readyCrew().machines;
    const crew = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      machines: [{ ...max!, state: "busy" }],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    render(<CrewPage swiff={atCrew("c1", library)} />);
    expect(
      await screen.findByRole("heading", { name: "Someone is just starting a game on Max's PC" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
  });

  it("counts the PCs when more than one is in, and says when none is on", async () => {
    const two = readyCrew({
      session: dated,
      shared: true,
      picks: 1,
      pcs: 2,
      machines: [
        { id: "q-max", name: null, owner: "Max", mine: false, state: "ready", games: [], playing: null },
        { id: "q-sam", name: null, owner: "Sam", mine: false, state: "busy", games: [], playing: null },
      ],
    });
    let crew = two;
    const { rerender } =
      (fetchFrom({ "GET /api/crews/c1": () => [200, { crew }] }), render(<CrewPage swiff={atCrew("c1")} />));
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading your games…")).toBeInTheDocument();
    crew = { ...two, state: "offline", pcs: 1, machines: [{ ...two.machines[0]!, state: "offline" }] };
    rerender(<CrewPage swiff={atCrew("c1", { crewChanges: 1 })} />);
    expect(await screen.findByRole("heading", { name: "No gaming PC is on right now" })).toBeInTheDocument();
    expect(screen.getByText("As soon as Max's PC is back on, you can play.")).toBeInTheDocument();
  });

  it("asks for the next date once the last session is over", async () => {
    const over = { ...dated, at: NOON.getTime() - 7 * 3600_000 };
    fetchFrom({ "GET /api/crews/c1": [200, { crew: readyCrew({ session: over, shared: true }) }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "When are you playing next?" })).toBeInTheDocument();
  });

  it("lets the admin rename the crew and make a new link, folded at the bottom", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "POST /api/crews/c1/name": [200, { crew: crewOf({ crewName: "Friday Squad" }) }],
      "POST /api/crews/c1/link": [200, { crew: crewOf({ crewName: "Friday Squad", token: NEW_TOKEN }) }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByText("More about the crew")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Your crew's name"), { target: { value: "Friday Squad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Friday Squad"));
    expect(calls).toContainEqual(["POST", "/api/crews/c1/name", '{"name":"Friday Squad"}']);
    expect(screen.getByText("Name saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make a new link" }));
    expect(await screen.findByText("New link made. The old one doesn't work any more.")).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/link"]);
  });

  it("asks before leaving, then leaves and goes back to the crews", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: joinedCrew() }],
      "POST /api/crew-members/m-sam/remove": [200, { removed: true }],
    });
    const swiff = atCrew("c1");
    render(<CrewPage swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave crew" }));
    expect(screen.getByRole("heading", { name: "Leave Lena's crew?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(calls.some(([, url]) => url.includes("remove"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Leave crew" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-sam/remove"]);
  });

  it("says so when a step did not work", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }], "POST /api/crews/c1/session": [500, {}] });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: /Set Fri 9 Oct, 9 pm/ }));
    expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pick a day in the calendar" })).toBeInTheDocument();
  });

  it("reads the crew again when the event stream says something changed", async () => {
    let crew = crewOf({ session: dated, size: 2, members: [{ ...LENA, rsvp: "yes" }, SAM] });
    const calls = fetchFrom({ "GET /api/crews/c1": () => [200, { crew }] });
    const swiff = atCrew("c1");
    const { rerender } = render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("1 in")).toBeInTheDocument();
    crew = { ...crew, session: { ...dated, yes: 2 }, members: [crew.members[0]!, { ...SAM, rsvp: "yes" }] };
    rerender(<CrewPage swiff={{ ...swiff, crewChanges: 1 }} />);
    expect(await screen.findByText("2 in")).toBeInTheDocument();
    expect(calls.filter(([, url]) => url.startsWith("/api/crews"))).toHaveLength(2);
  });

  it("celebrates in place when this crew's first PC comes in", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: readyCrew() }] });
    const swiff = atCrew("c1", { crewReady: "c1" });
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("Max's PC is in. You're ready to play!")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(swiff.dismissCrewReady).toHaveBeenCalled();
  });

  it("says a crew that is not the player's is not open to them", async () => {
    fetchFrom({});
    const swiff = atCrew("c9");
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("heading", { name: "This crew isn't open to you." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "To your crews" }));
    expect(swiff.openCrew).toHaveBeenCalledWith();
  });

  it("groups who is coming, nudges whoever has not answered on WhatsApp, and moves the date", async () => {
    const TOM: CrewMember = { ...SAM, id: "m-tom", name: "Tom" };
    const crew = readyCrew({
      session: { at: FRIDAY_9PM, yes: 2, no: 1 },
      shared: true,
      picks: 1,
      size: 4,
      members: [{ ...LENA, rsvp: "yes" }, { ...MAX, rsvp: "yes" }, { ...TOM, rsvp: "no" }, SAM],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Who's coming on Friday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In 2" }).parentElement).toHaveTextContent(
      /Lena \(you\).*Max/,
    );
    expect(screen.getByRole("heading", { name: "Can't 1" }).parentElement).toHaveTextContent("Tom");
    expect(screen.getByRole("heading", { name: "No answer yet 1" }).parentElement).toHaveTextContent("Sam");
    expect(screen.getByText("This is what Sam sees in the invite:")).toBeInTheDocument();
    expect(screen.getByText("Session on Friday 9 October, 9 pm. Are you in?")).toBeInTheDocument();
    expect(screen.getByText("Lena and Max are in.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Nudge Sam" }));
    const url = new URL(String(open.mock.calls[0]![0]));
    expect(url.origin).toBe("https://wa.me");
    expect(url.searchParams.get("text")!.split("\n")).toEqual([
      "Sam, are you in on Friday 9 October, 9 pm? Tap to say yes or no:",
      `${location.origin}/crews/c1`,
    ]);
    expect(await screen.findByText("Reminder shared.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Move the date/ }));
    expect(screen.getByRole("heading", { name: "Move the date" })).toBeInTheDocument();
  });

  it("nudges one member with no Steam name as one, not as a count of people", async () => {
    const crew = readyCrew({
      session: { at: FRIDAY_9PM, yes: 1, no: 0 },
      shared: true,
      picks: 1,
      size: 2,
      members: [
        { ...LENA, rsvp: "yes" },
        { ...SAM, name: null },
      ],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const { unmount } = render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("button", { name: "Nudge them" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nudge 1/ })).toBeNull();
    unmount();
    render(
      <ScreenLang.Provider value="de">
        <CrewPage swiff={atCrew("c1")} />
      </ScreenLang.Provider>,
    );
    expect(await screen.findByRole("button", { name: "Erinnern" })).toBeInTheDocument();
  });

  it("puts the Zockrunde in the viewer's own calendar, with an alert an hour before", async () => {
    const crew = joinedCrew({ rsvp: "yes" }, { session: { ...dated, yes: 2 } });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    const files: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      files.push(blob);
      return "blob:zockrunde";
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to my calendar" }));
    expect(click).toHaveBeenCalled();
    expect(files[0]!.type).toBe("text/calendar");
    // A member is never offered to move the date, but may nudge whoever has not answered.
    expect(screen.queryByRole("button", { name: /Move the date/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Nudge Lena" })).toBeInTheDocument();
  });

  it("writes the calendar file any calendar app opens: start, three hours, the crew page", () => {
    const ics = sessionCalendar(
      "de",
      { id: "c1", name: "Lena", crewName: "Couch, Koop; 1", own: true },
      FRIDAY_9PM,
      "https://lanterel.com",
      NOON.getTime(),
    ).split("\r\n");
    expect(ics).toContain("DTSTART:20261009T190000Z");
    expect(ics).toContain("DTEND:20261009T220000Z");
    expect(ics).toContain("DTSTAMP:20261007T100000Z");
    expect(ics).toContain("SUMMARY:Zockrunde: Couch\\, Koop\\; 1");
    expect(ics).toContain("URL:https://lanterel.com/crews/c1");
    expect(ics).toContain("TRIGGER:-PT1H");
    expect(ics.at(-1)).toBe("");
    expect(nudgeMessage("de", { id: "c1" }, ["Sami", "Tom"], FRIDAY_9PM, "https://lanterel.com")).toBe(
      "Sami und Tom, bist du am Freitag, 9. Oktober, 21 Uhr dabei? Sag kurz zu oder ab:\nhttps://lanterel.com/crews/c1",
    );
  });

  it("picks games once a PC is in: everyone's apart from some's, marked with a tap, the favourite on top", async () => {
    const CS = {
      id: 730,
      name: "Counter-Strike 2",
      image: "https://cdn.example/730.jpg",
      free: true,
      owners: 2,
      everyone: true,
      wants: ["m-max"],
      mine: false,
    };
    const PORTAL = { ...CS, id: 620, name: "Portal 2", free: false, owners: 1, everyone: false, wants: [] };
    const crew = readyCrew({ session: dated, shared: true });
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew }],
      "GET /api/crews/c1/games": [200, { games: [CS, PORTAL], size: 2 }],
      "POST /api/crews/c1/games": [
        200,
        { games: [{ ...CS, wants: ["m-max", "m-lena"], mine: true }, PORTAL], size: 2 },
      ],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(
      await screen.findByRole("heading", { name: "What do you want to play on Friday?" }),
    ).toBeInTheDocument();
    expect(stubs()).toEqual([
      "Date:done",
      "Get your people:done",
      "Gaming PC:done",
      "Pick games:now",
      "Play:later",
    ]);
    expect(await screen.findByText("Everyone can play these")).toBeInTheDocument();
    expect(screen.getByText("Only some of you have these")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 have it")).toBeInTheDocument();
    expect(screen.getByText("Crew favourite").parentElement).toHaveTextContent(
      "Counter-Strike 21 of 2 want it",
    );

    const tile = screen.getByRole("button", { name: /Counter-Strike 2.*Free, anyone can play/ });
    expect(tile).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByText("2 of 2 want it")).toBeInTheDocument());
    expect(calls).toContainEqual(["POST", "/api/crews/c1/games", JSON.stringify({ appid: 730, want: true })]);
    // Still picking: the step stays open until they say they are done.
    expect(screen.getByRole("heading", { name: "What do you want to play on Friday?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Done: 1 game marked/ }));
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
  });

  it("says so when there are no games on the PC yet, and lets the player go on", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: readyCrew({ session: dated, shared: true }) }],
      "GET /api/crews/c1/games": [200, { games: [], size: 2 }],
    });
    render(
      <ScreenLang.Provider value="de">
        <CrewPage swiff={atCrew("c1")} />
      </ScreenLang.Provider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Was willst du am Freitag zocken?" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Auf dem Gaming-PC der Crew sind noch keine Spiele/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    expect(
      await screen.findByRole("heading", { name: "Der Gaming-PC ist frei. Wer fängt an?" }),
    ).toBeInTheDocument();
  });

  it("counts picking games as done after a reload while the crew's PCs have none to pick", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: readyCrew({ session: dated, shared: true, offered: 0 }) }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(stubs()).toContain("Pick games:done");
    expect(stubs()).toContain("Play:now");
  });

  it("leaves picking games for later while the crew has no date, so a PC in means ready", async () => {
    fetchFrom({
      "GET /api/crews/c1": [
        200,
        {
          crew: joinedCrew(
            {},
            {
              state: "ready",
              pcs: 1,
              machines: [{ name: "DESKTOP-7Q", owner: "Max", mine: false, state: "ready" }],
            },
          ),
        },
      ],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(
      await screen.findByRole("heading", { name: "The gaming PC is free. Who goes first?" }),
    ).toBeInTheDocument();
    expect(stubs()).toContain("Pick games:later");
    expect(stubs()).toContain("Play:now");
  });

  it("offers to try again when the crew could not be read", async () => {
    let answer: [number, unknown] = [503, {}];
    fetchFrom({ "GET /api/crews/c1": () => answer });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Your crew couldn't be loaded." })).toBeInTheDocument();
    answer = [200, { crew: crewOf() }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Pick a day in the calendar" })).toBeInTheDocument();
  });
});

describe("CrewInvite", () => {
  const OPEN = {
    name: "Lena",
    crewName: null,
    own: false,
    size: 2,
    state: "no-pc",
    pcs: 0,
    session: null,
    member: false,
    guests: [{ name: "Lena", admin: true, rsvp: null }],
  };
  const JOINED = { id: "c1", crew: { ...OPEN, member: undefined, size: 3 }, joined: true };

  const at = (path: string) => history.replaceState(null, "", path);

  it("names who asks and the crew, and signs a signed-out friend in with Steam, keeping the token out", async () => {
    at(`/invite/${TOKEN}?from=wa`);
    const calls = fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }] });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false, screen: "invite" })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Lena wants you in the crew.");
    expect(screen.getByText("Gaming PC: still missing.")).toBeInTheDocument();
    expect(screen.getByText("No date yet. Join, and you'll plan a session together.")).toBeInTheDocument();
    expect(screen.queryByText(/Can't make it/)).toBeNull();
    const links = screen.getAllByRole("link", { name: /Join with Steam/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/auth/steam/login?to=%2Finvite");
    expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    expect(location.pathname + location.search).toBe("/invite?from=wa");
    expect(sessionStorage.getItem("swiff.invite")).toBe(TOKEN);
    expect(calls.some(([method]) => method === "POST")).toBe(false);
  });

  const when = Date.UTC(2026, 9, 9, 19); // 21:00 in Berlin
  const DATED = {
    ...OPEN,
    size: 3,
    session: { at: when, yes: 1, no: 1 },
    guests: [
      { name: "Lena", admin: true, rsvp: "yes" },
      { name: "Tom", admin: false, rsvp: "no" },
    ],
  };

  it("puts the session's date and who is coming on the ticket, with the friend's own spot open", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: DATED }] });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(await screen.findByText("Session on Friday 9 October, at 9 pm. Are you in?")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /Session\s*Fri 9 Oct\s*21:00/ }),
    ).toBeInTheDocument();
    const rows = screen.getByRole("list", { name: "Who's coming" }).querySelectorAll("li");
    expect([...rows].map((li) => li.textContent)).toEqual([
      "LLenastarted the crewIn",
      "TTomCan't",
      "?Your spotLena's saving it for you.No answer yet",
    ]);
    expect(screen.getByRole("link", { name: /I'm in\s*Join with Steam/ })).toBeInTheDocument();
    expect(screen.getByText("On Friday, open the crew page")).toBeInTheDocument();
  });

  it("joins and says yes with the one button, or joins and says no", async () => {
    at(`/invite/${TOKEN}`);
    const calls = fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: DATED }],
      [`POST /api/invites/${TOKEN}/join`]: [200, JOINED],
    });
    const swiff = fakeSwiff();
    const { unmount } = render(<CrewInvite swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: "I'm in" }));
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    unmount();
    at(`/invite/${TOKEN}`);
    render(<CrewInvite swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: "Can't make it, but join the crew anyway" }));
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledTimes(2));
    expect(calls.filter(([method]) => method === "POST")).toEqual([
      ["POST", `/api/invites/${TOKEN}/join`, '{"rsvp":"yes"}'],
      ["POST", `/api/invites/${TOKEN}/join`, '{"rsvp":"no"}'],
    ]);
  });

  it("keeps the answer a signed-out friend chose through Steam, and gives it on joining", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: DATED }] });
    const { unmount } = render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    const cant = await screen.findByRole("link", { name: "Can't make it, but join the crew anyway" });
    cant.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(cant);
    expect(sessionStorage.getItem("swiff.inviteJoin")).toBe("no");
    unmount();

    at("/invite");
    const calls = fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: DATED }],
      [`POST /api/invites/${TOKEN}/join`]: [200, JOINED],
    });
    const swiff = fakeSwiff();
    render(<CrewInvite swiff={swiff} />);
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    expect(calls.filter(([method]) => method === "POST")).toEqual([
      ["POST", `/api/invites/${TOKEN}/join`, '{"rsvp":"no"}'],
    ]);
  });

  it("names the crew by its own name", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({
      [`/api/invites/${TOKEN}`]: [
        200,
        { crew: { ...OPEN, crewName: "Friday Squad", state: "ready", pcs: 2 } },
      ],
    });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Lena wants you in Friday Squad.",
    );
    expect(screen.getByText("2 gaming PCs: in.")).toBeInTheDocument();
  });

  it("speaks of the crew, never a blank name, when Steam gave the admin none", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({
      [`/api/invites/${TOKEN}`]: [
        200,
        { crew: { ...OPEN, name: null, guests: [{ name: null, admin: true, rsvp: null }] } },
      ],
    });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("You're invited to the crew.");
    expect(screen.getByText("It's waiting for you.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ 's|\?'s|null/);
  });

  it("leaves the token in the path when storage is blocked", async () => {
    at(`/invite/${TOKEN}`);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }] });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    const [link] = await screen.findAllByRole("link", { name: /Join with Steam/ });
    expect(link).toHaveAttribute("href", `/auth/steam/login?to=%2Finvite%2F${TOKEN}`);
    expect(location.pathname).toBe(`/invite/${TOKEN}`);
  });

  it("joins a signed-in friend with one button and opens the crew", async () => {
    at(`/invite/${TOKEN}`);
    const calls = fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }],
      [`POST /api/invites/${TOKEN}/join`]: [200, JOINED],
    });
    const swiff = fakeSwiff();
    render(<CrewInvite swiff={swiff} />);
    const [join] = await screen.findAllByRole("button", { name: /^Join/ });
    expect(screen.queryByRole("link", { name: /Join with Steam/ })).toBeNull();
    fireEvent.click(join!);
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    expect(calls.filter(([method]) => method === "POST")).toEqual([["POST", `/api/invites/${TOKEN}/join`]]);
  });

  it("says why a player in as many crews as anyone may be cannot join", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }],
      [`POST /api/invites/${TOKEN}/join`]: [409, { code: "too-many-crews" }],
    });
    const swiff = fakeSwiff();
    render(<CrewInvite swiff={swiff} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /^Join/ }))[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Leave one to start or join another.");
    expect(swiff.openCrew).not.toHaveBeenCalled();
  });

  it("says so when joining did not work, and treats a dead link as one", async () => {
    at(`/invite/${TOKEN}`);
    let join: [number, unknown] = [500, {}];
    fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }],
      [`POST /api/invites/${TOKEN}/join`]: () => join,
    });
    const swiff = fakeSwiff();
    render(<CrewInvite swiff={swiff} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /^Join/ }))[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Joining didn't work. Try again.");
    join = [404, { error: "gone" }];
    fireEvent.click(screen.getAllByRole("button", { name: /^Join/ })[0]!);
    expect(
      await screen.findByRole("heading", { name: "This crew link doesn't work any more." }),
    ).toBeInTheDocument();
    expect(swiff.openCrew).not.toHaveBeenCalled();
  });

  it("joins at once, back from Steam at /invite with the remembered token", async () => {
    sessionStorage.setItem("swiff.invite", TOKEN);
    sessionStorage.setItem("swiff.inviteJoin", "1");
    at("/invite");
    const calls = fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }],
      [`POST /api/invites/${TOKEN}/join`]: [200, JOINED],
    });
    const swiff = fakeSwiff({ signInKnown: false, signedIn: false });
    const { rerender } = render(<CrewInvite swiff={swiff} />);
    await screen.findByRole("heading", { level: 1 });
    expect(calls.some(([method]) => method === "POST")).toBe(false);

    const signedIn = { ...swiff, signInKnown: true, signedIn: true } as Swiff;
    rerender(<CrewInvite swiff={signedIn} />);
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith("c1"));
    rerender(<CrewInvite swiff={{ ...signedIn }} />);
    await act(async () => {});
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(1);
    // Joined, the tab forgets the link: Back or a reload asks again.
    expect(sessionStorage.getItem("swiff.invite")).toBeNull();
    expect(sessionStorage.getItem("swiff.inviteJoin")).toBeNull();
  });

  it("never joins on a reload or Back to /invite: only a trip to Steam to join does", async () => {
    sessionStorage.setItem("swiff.invite", TOKEN);
    at("/invite");
    const calls = fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }] });
    render(<CrewInvite swiff={fakeSwiff()} />);
    expect(await screen.findAllByRole("button", { name: /^Join/ })).not.toHaveLength(0);
    await act(async () => {});
    expect(calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("notes the trip to Steam when a signed-out friend chooses to join", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }] });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    const [link] = await screen.findAllByRole("link", { name: /Join with Steam/ });
    link!.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link!);
    expect(sessionStorage.getItem("swiff.inviteJoin")).toBe("join");
  });

  it("tells someone already in the crew so, and takes them to it", async () => {
    at(`/invite/${TOKEN}`);
    const calls = fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: { ...OPEN, member: true } }] });
    const swiff = fakeSwiff();
    render(<CrewInvite swiff={swiff} />);
    expect(await screen.findByText("You're already in this crew.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Go to the crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith();
    expect(calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("says plainly when a link opens nothing any more", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({});
    const swiff = fakeSwiff({ signedIn: false });
    render(<CrewInvite swiff={swiff} />);
    expect(
      await screen.findByRole("heading", { name: "This crew link doesn't work any more." }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ask your group for the new link.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the start" }));
    expect(swiff.goStart).toHaveBeenCalled();
  });

  it("opens nothing at a bare /invite with no token remembered", () => {
    at("/invite");
    const calls = fetchFrom({});
    render(<CrewInvite swiff={fakeSwiff()} />);
    expect(
      screen.getByRole("heading", { name: "This crew link doesn't work any more." }),
    ).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("offers to try again when the server gives no answer", async () => {
    at(`/invite/${TOKEN}`);
    let answer: [number, unknown] = [503, {}];
    fetchFrom({ [`/api/invites/${TOKEN}`]: () => answer });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false })} />);
    expect(
      await screen.findByRole("heading", { name: "The invite couldn't be opened." }),
    ).toBeInTheDocument();
    answer = [200, { crew: OPEN }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Lena wants you in the crew.");
  });
});

describe("the ways into crews", () => {
  it("lists the player's crews on the card, each opening its page, and founds another", async () => {
    fetchFrom({ "GET /api/crews": [200, { crews: [crewOf(), readyCrew({ id: "c2", name: "Max" })] }] });
    const swiff = fakeSwiff({ screen: "profile" });
    render(<CrewsCard swiff={swiff} />);
    expect(await screen.findByText("Lena's crew · Almost ready.")).toBeInTheDocument();
    expect(screen.getByText("Max's crew · Ready to play!")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[1]!);
    expect(swiff.openCrew).toHaveBeenCalledWith("c2");
    fireEvent.click(screen.getByRole("button", { name: /Start a new crew/ }));
    expect(swiff.foundCrew).toHaveBeenCalled();
  });

  it("offers founding on the card to a player in no crew", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [] }] });
    const swiff = fakeSwiff({ screen: "profile" });
    render(<CrewsCard swiff={swiff} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Start a crew/ }));
    expect(swiff.foundCrew).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("puts the wall's strip away for good once the player says not now", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [] }] });
    const swiff = fakeSwiff({ screen: "home" });
    const { unmount } = render(<CrewStrip swiff={swiff} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Start a crew/ }));
    expect(swiff.foundCrew).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("crew-strip")).toBeNull();
    expect(localStorage.getItem("swiff.crewStripDismissed")).toBe("1");
    unmount();
    render(<CrewStrip swiff={swiff} />);
    expect(screen.queryByTestId("crew-strip")).toBeNull();
  });

  it("takes the wall's strip to the crew a player is in", async () => {
    fetchFrom({ "GET /api/crews": [200, { crews: [crewOf()] }] });
    const swiff = fakeSwiff({ screen: "home" });
    render(<CrewStrip swiff={swiff} />);
    fireEvent.click(await screen.findByRole("button", { name: /Go to your crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("c1");
  });

  it("shows the ready banner on any other screen when a crew gets its first PC", async () => {
    fetchFrom({ "GET /api/crews": [200, { crews: [crewOf({ id: "c0" }), readyCrew()] }] });
    const swiff = fakeSwiff({ screen: "home", crewReady: "c1" });
    render(<CrewReadyBanner swiff={swiff} />);
    const banner = await screen.findByTestId("crew-ready");
    expect(banner).toHaveTextContent("Lena's crew has a gaming PC. You're ready to play!");
    fireEvent.click(screen.getByRole("button", { name: "Go to the crew" }));
    expect(swiff.openCrew).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(swiff.dismissCrewReady).toHaveBeenCalled();
  });

  it("leaves the ready banner off on that crew's own page, but shows it on another crew's", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [readyCrew()] }] });
    const own = fakeSwiff({ crewReady: "c1", crewRoute: { crew: "c1" } });
    const { unmount } = render(<CrewReadyBanner swiff={own} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByTestId("crew-ready")).toBeNull();
    unmount();

    render(<CrewReadyBanner swiff={fakeSwiff({ crewReady: "c1", crewRoute: { crew: "c2" } })} />);
    expect(await screen.findByTestId("crew-ready")).toBeInTheDocument();
  });

  it("reads nothing while no crew is newly ready", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [readyCrew()] }] });
    render(<CrewReadyBanner swiff={fakeSwiff({ screen: "home" })} />);
    await act(async () => {});
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("crew-ready")).toBeNull();
  });
});

describe("CrewPage: landing from the marketing site", () => {
  it("founds a crew at once for a player with none, and leaves one who has a crew in it", async () => {
    history.replaceState(null, "", "/crews?found=1&pc=1");
    const calls = fetchFrom({
      "GET /api/crews": [200, { crews: [] }],
      "POST /api/crews": [201, { crew: crewOf({ id: "c-new" }) }],
    });
    const swiff = fakeSwiff();
    const { unmount } = render(<CrewPage swiff={swiff} />);
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(location.pathname + location.search).toBe("/crews");
    expect(sessionStorage.getItem("crew.pcFirst")).toBe("1");
    unmount();

    history.replaceState(null, "", "/crews?found=1");
    fetchFrom({ "GET /api/crews": [200, { crews: [{ ...crewOf(), pcArrived: false }] }] });
    const back = fakeSwiff();
    render(<CrewPage swiff={back} />);
    await waitFor(() => expect(back.replaceCrew).toHaveBeenCalledWith("c1"));
    expect(back.replaceCrew).toHaveBeenCalledTimes(1);
  });

  it("does not found another crew on its own for a player with several", async () => {
    history.replaceState(null, "", "/crews?found=1");
    const two = [
      { ...crewOf(), pcArrived: false },
      { ...crewOf({ id: "c2" }), pcArrived: false },
    ];
    fetchFrom({ "GET /api/crews": [200, { crews: two }] });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("Your crews")).toBeInTheDocument();
    expect(swiff.replaceCrew).not.toHaveBeenCalled();
  });

  it("founds a new crew from the app's own button, even for a player already in one", async () => {
    history.replaceState(null, "", "/crews?found=new");
    const calls = fetchFrom({
      "GET /api/crews": [200, { crews: [{ ...crewOf(), pcArrived: false }] }],
      "POST /api/crews": [201, { crew: crewOf({ id: "c-new" }) }],
    });
    const swiff = fakeSwiff();
    render(<CrewPage swiff={swiff} />);
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(swiff.replaceCrew).toHaveBeenCalledTimes(1);
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(location.pathname + location.search).toBe("/crews");
  });

  it("shows someone from the host side the gaming PC step first", async () => {
    sessionStorage.setItem("crew.pcFirst", "1");
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Who brings the gaming PC?" })).toBeInTheDocument();
    expect(sessionStorage.getItem("crew.pcFirst")).toBeNull();
  });
});
