// Crews on the page: founding one in a tap, the crews a player is in, one
// crew's lobby, the invite page a crew's link opens, and the ways into crews
// from the rest of the app (the card, the wall's strip, the ready banner).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREW_COPY, crewText, langOf, possessive } from "./crewCopy";
import { CrewInvite } from "./CrewInvite";
import { CrewPage } from "./CrewPage";
import {
  crewRouteAt,
  crewTitle,
  inviteMessage,
  pcTitle,
  type CrewDetail,
  type CrewMember,
  type MyCrew,
} from "./crews";
import { CrewReadyBanner, CrewStrip, CrewsCard } from "./CrewsCard";
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
    crewRoute: { crew: null, found: false },
    crewChanges: 0,
    crewReady: null,
    dismissCrewReady: vi.fn(),
    openCrew: vi.fn(),
    replaceCrew: vi.fn(),
    goHome: vi.fn(),
    inviteShared: vi.fn(),
    ...over,
  } as unknown as Swiff;
}

const atCrew = (id: string, over: Record<string, unknown> = {}) =>
  fakeSwiff({ crewRoute: { crew: id, found: false }, ...over });

const LENA: CrewMember = { id: "m-lena", name: "Lena", you: true, admin: true, pc: null, pcs: 0 };
const SAM: CrewMember = { id: "m-sam", name: "Sam", you: false, admin: false, pc: null, pcs: 0 };
const MAX: CrewMember = { id: "m-max", name: "Max", you: false, admin: false, pc: "yes", pcs: 1 };

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
    token: TOKEN,
    members: [LENA],
    machines: [],
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
    machines: [{ name: "DESKTOP-7Q", owner: "Max", mine: false, state: "ready" }],
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
  it("reads /crews, /crews/new and /crews/<id>, and opens the crew screen there", () => {
    expect(crewRouteAt("/crews")).toEqual({ crew: null, found: false });
    expect(crewRouteAt("/crews/")).toEqual({ crew: null, found: false });
    expect(crewRouteAt("/crews/new")).toEqual({ crew: null, found: true });
    expect(crewRouteAt("/crews/c-42")).toEqual({ crew: "c-42", found: false });
    expect(crewRouteAt("/crewsy")).toBeNull();
    expect(crewRouteAt("/crews/a/b")).toBeNull();
    expect(screenAt("/crews")).toBe("crew");
    expect(screenAt("/crews/new")).toBe("crew");
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
      "/auth/steam/login?to=%2Fcrews%2Fnew",
    );
    expect(screen.getByText("Sign in with Steam first. No password, no new account.")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("founds the crew once at /crews/new and puts its id in the address", async () => {
    const calls = fetchFrom({ "POST /api/crews": [201, { crew: crewOf({ id: "c-new" }) }] });
    const swiff = fakeSwiff({ crewRoute: { crew: null, found: true } });
    render(
      <StrictMode>
        <CrewPage swiff={swiff} />
      </StrictMode>,
    );
    expect(screen.getByText("Starting your crew…")).toBeInTheDocument();
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(calls).toEqual([["POST", "/api/crews", "{}"]]);
    expect(swiff.replaceCrew).toHaveBeenCalledTimes(1);
  });

  it("says so when the crew could not be founded, and tries again", async () => {
    let answer: [number, unknown] = [500, {}];
    const calls = fetchFrom({ "POST /api/crews": () => answer });
    const swiff = fakeSwiff({ crewRoute: { crew: null, found: true } });
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your crew couldn't be started. Try again.");
    answer = [201, { crew: crewOf({ id: "c-new" }) }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("c-new"));
    expect(calls.filter(([method]) => method === "POST")).toHaveLength(2);
  });

  it("says why when the player is in as many crews as anyone may be, and offers their crews", async () => {
    const calls = fetchFrom({ "POST /api/crews": [409, { code: "too-many-crews" }] });
    const swiff = fakeSwiff({ crewRoute: { crew: null, found: true } });
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You're in 50 crews already");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "To your crews" }));
    expect(swiff.openCrew).toHaveBeenCalledWith();
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
    fireEvent.click(screen.getByRole("button", { name: /Start a new crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("new");
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
    fireEvent.click(await screen.findByRole("button", { name: /Start a crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("new");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Start your crew");
  });
});

describe("CrewPage: a crew's lobby", () => {
  it("leads the founder of a crew with no PC to getting their people in", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByText("Almost ready.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lena's crew");
    expect(screen.getByRole("heading", { name: "Get your people into the crew" })).toBeInTheDocument();
    expect(screen.getByText("still missing")).toBeInTheDocument();
    expect(screen.getByText(`${location.host}/invite/${TOKEN}`)).toBeInTheDocument();
    // The founder is not pushed into the PC card; they can open it themselves.
    expect(screen.queryByTestId("pc-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I've got a gaming PC" }));
    expect(screen.getByTestId("pc-card")).toHaveTextContent("The crew sees");
  });

  it("shares the invite on WhatsApp through the phone's share sheet where there is one", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    const share = stubShareSheet();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const swiff = atCrew("c1");
    render(<CrewPage swiff={swiff} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Share on WhatsApp" }))[0]!);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const { text } = share.mock.calls[0]![0];
    expect(text).toContain("who's got a gaming PC?");
    expect(text).toContain(`${location.origin}/invite/${TOKEN}`);
    expect(open).not.toHaveBeenCalled();
    expect(swiff.inviteShared).toHaveBeenCalledWith("whatsapp");
    expect(
      await screen.findByText("Question shared. When a gaming PC joins, we'll tell everyone."),
    ).toBeInTheDocument();
  });

  it("shares the invite through wa.me where the browser has no share sheet", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Share on WhatsApp" }))[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(target).toBe("_blank");
    const text = decodeURIComponent(String(url).slice("https://wa.me/?text=".length));
    expect(text).toContain("I set up a crew for us: Lena's crew");
    expect(text).toContain("who's got a gaming PC?");
    expect(text).toContain(`/invite/${TOKEN}`);
    // No "More" without a share sheet.
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("shows someone who joined what the crew sees on a PC and what it doesn't, and Later keeps a chip", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: joinedCrew() }],
      "POST /api/crews/c1/pc": [200, { crew: joinedCrew({ pc: "later" }) }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    const card = await screen.findByTestId("pc-card");
    expect(card).toHaveTextContent("Got a gaming PC? Then your crew can get going.");
    expect(card).toHaveTextContent("The crew sees");
    expect(card).toHaveTextContent("Steam, each on their own account, with their own games");
    expect(card).toHaveTextContent("The crew doesn't see");
    expect(card).toHaveTextContent("your Windows, your files, your home network, your Steam account");
    expect(screen.getByRole("heading", { name: "Got a gaming PC?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check my PC later" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(await screen.findByRole("button", { name: "Check my PC later" })).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/pc", '{"pc":"later"}']);
    expect(screen.queryByTestId("pc-card")).toBeNull();
    expect(screen.getByText("Got it. You'll find it up top under “Check my PC later”.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check my PC later" }));
    expect(screen.getByTestId("pc-card")).toBeInTheDocument();
  });

  it("checks a PC with the crew and says the app is coming soon while there is no download", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: joinedCrew() }],
      "POST /api/crews/c1/pc": [200, { crew: joinedCrew({ pc: "yes" }) }],
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check my PC \(takes a minute\)/ }));
    const soon = "The Lanterel app for your PC is coming soon. Once it runs, your PC plays for Lena's crew.";
    expect((await screen.findAllByText(soon)).length).toBeGreaterThan(0);
    expect(calls).toContainEqual(["POST", "/api/crews/c1/pc", '{"pc":"yes"}']);
    expect(screen.getByRole("heading", { name: "Almost there: set up your gaming PC" })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("says so when answering the PC card did not work", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: joinedCrew() }],
      "POST /api/crews/c1/pc": [500, {}],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId("pc-card")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check my PC later" })).toBeNull();
  });

  it("is ready to play once a PC is in, and Play now goes to the games", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: readyCrew() }] });
    const swiff = atCrew("c1");
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("Ready to play!")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "You're ready to play!" })).toBeInTheDocument();
    expect(screen.getByText("Max's PC is in. Pick a game and start playing.")).toBeInTheDocument();
    expect(screen.getByText("Max's PC is in")).toBeInTheDocument();
    expect(screen.getByText("brings the gaming PC")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a gaming PC/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Play now/ }));
    expect(swiff.goHome).toHaveBeenCalled();
  });

  it("counts the PCs when more than one is in", async () => {
    const crew = readyCrew({
      pcs: 2,
      machines: [
        { name: "DESKTOP-7Q", owner: "Max", mine: false, state: "busy" },
        { name: null, owner: "Lena", mine: true, state: "ready" },
      ],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(
      await screen.findByText("2 gaming PCs are in. Pick a game and start playing."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 PCs in")).toBeInTheDocument();
    expect(screen.getByText("busy")).toBeInTheDocument();
    expect(screen.getByText("your PC")).toBeInTheDocument();
    expect(screen.getByTestId("pc-card")).toHaveTextContent("Your PC plays for Lena's crew.");
  });

  it("says when no PC is on right now", async () => {
    const crew = readyCrew({
      state: "offline",
      machines: [{ name: "DESKTOP-7Q", owner: "Max", mine: false, state: "offline" }],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByText("No PC on right now.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No gaming PC is on right now" })).toBeInTheDocument();
    expect(screen.getByText("As soon as Max's PC is back on, you can play.")).toBeInTheDocument();
    expect(screen.getByText("off right now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Play now/ })).toBeNull();
  });

  it("lets someone who joined a ready crew add a second PC, without pushing the card on them", async () => {
    const ready = readyCrew({
      memberId: "m-sam",
      own: false,
      size: 3,
      members: [{ ...LENA, you: false }, MAX, { ...SAM, you: true }],
    });
    const withSam = {
      ...ready,
      pcs: 2,
      members: [{ ...LENA, you: false }, MAX, { ...SAM, you: true, pc: "yes" as const, pcs: 1 }],
      machines: [...ready.machines, { name: null, owner: "Sam", mine: true, state: "ready" as const }],
    };
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: ready }],
      "POST /api/crews/c1/pc": [200, { crew: withSam }],
    });
    vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByText("Ready to play!")).toBeInTheDocument();
    expect(screen.queryByTestId("pc-card")).toBeNull();
    expect(screen.getByRole("button", { name: /Add another gaming PC/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "I've got a gaming PC" }));
    fireEvent.click(screen.getByRole("button", { name: /Check my PC \(takes a minute\)/ }));
    expect(await screen.findByText("2 PCs in")).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/pc", '{"pc":"yes"}']);
    expect(screen.getByTestId("pc-card")).toHaveTextContent("Your PC plays for Lena's crew.");
    expect(screen.queryByRole("button", { name: /Add another gaming PC/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "I've got a gaming PC" })).toBeNull();
  });

  it("offers another PC in German too, and from a crew whose PCs are all off", async () => {
    const crew = readyCrew({
      state: "offline",
      machines: [{ name: "DESKTOP-7Q", owner: "Max", mine: false, state: "offline" }],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    render(
      <ScreenLang.Provider value="de">
        <CrewPage swiff={atCrew("c1")} />
      </ScreenLang.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Noch einen Gaming-PC hinzufügen/ }));
    expect(screen.getByTestId("pc-card")).toHaveTextContent("Die Crew sieht");
    expect(screen.getByRole("button", { name: "Ich hab einen Gaming-PC" })).toBeInTheDocument();
  });

  it("lets the admin rename the crew", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "POST /api/crews/c1/name": [200, { crew: crewOf({ crewName: "Friday Squad" }) }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Your crew's name"), { target: { value: "Friday Squad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Friday Squad"));
    expect(calls).toContainEqual(["POST", "/api/crews/c1/name", '{"name":"Friday Squad"}']);
    expect(screen.getByText("Name saved.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your crew's name")).toBeNull();
  });

  it("lets the admin make a new link and remove someone", async () => {
    let crew = crewOf({ size: 2, members: [LENA, SAM] });
    const calls = fetchFrom({
      "GET /api/crews/c1": () => [200, { crew }],
      "POST /api/crews/c1/link": [200, { crew: crewOf({ size: 2, members: [LENA, SAM], token: NEW_TOKEN }) }],
      "POST /api/crew-members/m-sam/remove": () => {
        crew = crewOf({ token: NEW_TOKEN });
        return [200, { removed: true }];
      },
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Make a new link" }));
    expect(await screen.findByText(`${location.host}/invite/${NEW_TOKEN}`)).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/link"]);
    expect(screen.getByText("New link made. The old one doesn't work any more.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
    await waitFor(() => expect(screen.queryByText("Sam")).toBeNull());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-sam/remove"]);
  });

  it("gives someone who is not the admin no rename, renew or remove", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: joinedCrew() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    await screen.findByTestId("pc-card");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make a new link" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "I've got a gaming PC" })).toBeNull();
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
    expect(screen.queryByRole("heading", { name: "Leave Lena's crew?" })).toBeNull();
    expect(calls.some(([, url]) => url.includes("remove"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Leave crew" }));
    expect(
      screen.getByText("Everyone else keeps playing, and the link gets you back anytime."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-sam/remove"]);
  });

  it("posts a session on WhatsApp from Plan a session", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: readyCrew() }] });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan a session" }));
    expect(screen.getByRole("heading", { name: "When are you playing?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    fireEvent.click(screen.getByRole("button", { name: /Post the session on WhatsApp/ }));
    const [url] = open.mock.calls[0]!;
    const text = decodeURIComponent(String(url).slice("https://wa.me/?text=".length));
    expect(text).toMatch(/^Tomorrow, .+: session for Lena's crew 🎮 Who's in\? /);
    expect(text).toContain(`/invite/${TOKEN}`);
    expect(await screen.findByText("Session posted.")).toBeInTheDocument();
  });

  it("reads the crew again when the event stream says something changed", async () => {
    let crew = crewOf();
    const calls = fetchFrom({ "GET /api/crews/c1": () => [200, { crew }] });
    const swiff = atCrew("c1");
    const { rerender } = render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("Almost ready.")).toBeInTheDocument();
    const crewCalls = () => calls.filter(([, url]) => url.startsWith("/api/crews"));
    expect(crewCalls()).toHaveLength(1);

    crew = readyCrew();
    rerender(<CrewPage swiff={{ ...swiff, crewChanges: 1 }} />);
    expect(await screen.findByText("Ready to play!")).toBeInTheDocument();
    expect(crewCalls()).toEqual([
      ["GET", "/api/crews/c1"],
      ["GET", "/api/crews/c1"],
    ]);
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

  it("offers to try again when the crew could not be read", async () => {
    let answer: [number, unknown] = [503, {}];
    fetchFrom({ "GET /api/crews/c1": () => answer });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByRole("heading", { name: "Your crew couldn't be loaded." })).toBeInTheDocument();
    answer = [200, { crew: crewOf() }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Almost ready.")).toBeInTheDocument();
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
    member: false,
  };
  const JOINED = { id: "c1", crew: { ...OPEN, member: undefined, size: 3 }, joined: true };

  const at = (path: string) => history.replaceState(null, "", path);

  it("names who asks and the crew, and signs a signed-out friend in with Steam, keeping the token out", async () => {
    at(`/invite/${TOKEN}?from=wa`);
    const calls = fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: OPEN }] });
    render(<CrewInvite swiff={fakeSwiff({ signedIn: false, screen: "invite" })} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Lena wants you in the crew.");
    expect(screen.getByText("Almost ready. A gaming PC is still missing.")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /Join with Steam/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/auth/steam/login?to=%2Finvite");
    expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    expect(location.pathname + location.search).toBe("/invite?from=wa");
    expect(sessionStorage.getItem("swiff.invite")).toBe(TOKEN);
    expect(calls.some(([method]) => method === "POST")).toBe(false);
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
    expect(screen.getByText("Ready to play. 2 gaming PCs are in.")).toBeInTheDocument();
  });

  it("speaks of the crew, never a blank name, when Steam gave the admin none", async () => {
    at(`/invite/${TOKEN}`);
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: { ...OPEN, name: null } }] });
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
    expect(sessionStorage.getItem("swiff.inviteJoin")).toBe("1");
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
    expect(swiff.goHome).toHaveBeenCalled();
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
    expect(swiff.openCrew).toHaveBeenCalledWith("new");
  });

  it("offers founding on the card to a player in no crew", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [] }] });
    const swiff = fakeSwiff({ screen: "profile" });
    render(<CrewsCard swiff={swiff} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Start a crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("new");
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("puts the wall's strip away for good once the player says not now", async () => {
    const calls = fetchFrom({ "GET /api/crews": [200, { crews: [] }] });
    const swiff = fakeSwiff({ screen: "home" });
    const { unmount } = render(<CrewStrip swiff={swiff} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Start a crew/ }));
    expect(swiff.openCrew).toHaveBeenCalledWith("new");
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
    const own = fakeSwiff({ crewReady: "c1", crewRoute: { crew: "c1", found: false } });
    const { unmount } = render(<CrewReadyBanner swiff={own} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByTestId("crew-ready")).toBeNull();
    unmount();

    render(
      <CrewReadyBanner swiff={fakeSwiff({ crewReady: "c1", crewRoute: { crew: "c2", found: false } })} />,
    );
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
    fetchFrom({ "GET /api/crews": [200, { crews: [] }] });
    const swiff = fakeSwiff();
    const { unmount } = render(<CrewPage swiff={swiff} />);
    await waitFor(() => expect(swiff.replaceCrew).toHaveBeenCalledWith("new"));
    expect(location.pathname + location.search).toBe("/crews");
    expect(sessionStorage.getItem("crew.pcFirst")).toBe("1");
    unmount();

    history.replaceState(null, "", "/crews?found=1");
    fetchFrom({ "GET /api/crews": [200, { crews: [{ ...crewOf(), pcArrived: false }] }] });
    const back = fakeSwiff();
    render(<CrewPage swiff={back} />);
    await waitFor(() => expect(back.replaceCrew).toHaveBeenCalledWith("c1"));
    expect(back.replaceCrew).not.toHaveBeenCalledWith("new");
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

  it("shows someone from the host side the PC card first", async () => {
    sessionStorage.setItem("crew.pcFirst", "1");
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByTestId("pc-card")).toBeInTheDocument();
    expect(sessionStorage.getItem("crew.pcFirst")).toBeNull();
  });
});

describe("CrewPage: sharing and reminders", () => {
  it("leads every crew's share block with WhatsApp", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: readyCrew() }] });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrewPage swiff={atCrew("c1")} />);
    const buttons = await screen.findAllByRole("button", { name: "Share on WhatsApp" });
    const primary = buttons.find((b) => b.classList.contains("lb-wa"));
    expect(primary).toBeDefined();
    fireEvent.click(primary!);
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0]![0])).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("offers no reminders while the server takes none", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: crewOf() }] });
    render(<CrewPage swiff={atCrew("c1")} />);
    await screen.findByText("Almost ready.");
    expect(screen.queryByTestId("reminders")).toBeNull();
  });

  it("takes an optional address for reminders, which waits for its confirmation", async () => {
    let reminders = { email: null as string | null, confirmed: false };
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "GET /api/signups/reminders": () => [200, reminders],
      "POST /api/signups/reminders": () => {
        reminders = { email: "lena@example.com", confirmed: false };
        return [200, reminders];
      },
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    const field = await screen.findByLabelText("Email address");
    fireEvent.change(field, { target: { value: "not an address" } });
    fireEvent.click(screen.getByRole("button", { name: "Remind me" }));
    expect(await screen.findByText("That doesn't look like an email address.")).toBeInTheDocument();
    expect(calls.some(([method, url]) => method === "POST" && url.includes("signups"))).toBe(false);

    fireEvent.change(field, { target: { value: " lena@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Remind me" }));
    expect(
      await screen.findByText("Almost there: click the link in the email to lena@example.com."),
    ).toBeInTheDocument();
    const posted = calls.find(([method, url]) => method === "POST" && url === "/api/signups/reminders");
    expect(JSON.parse(posted![2]!)).toEqual({ email: "lena@example.com", lang: "en" });
  });

  it("says when to ask again when the server held the confirm mail back, never to click a link", async () => {
    const retryAt = new Date(2026, 9, 7, 15, 30).getTime();
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "GET /api/signups/reminders": [200, { email: null, confirmed: false }],
      "POST /api/signups/reminders": [200, { email: "lena@example.com", confirmed: false, retryAt }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: "lena@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Remind me" }));
    expect(
      await screen.findByText(
        "lena@example.com already got an email from us a moment ago; you can ask for a new one from 3:30 pm.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/click the link/)).toBeNull();
  });

  it("shows confirmed reminders with a way to stop them", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: crewOf() }],
      "GET /api/signups/reminders": [200, { email: "lena@example.com", confirmed: true }],
      "POST /api/signups/reminders/off": [200, { email: null, confirmed: false }],
    });
    render(<CrewPage swiff={atCrew("c1")} />);
    expect(await screen.findByText("Reminders go to lena@example.com.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop reminders" }));
    expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
    expect(calls.some(([method, url]) => method === "POST" && url === "/api/signups/reminders/off")).toBe(
      true,
    );
  });
});
