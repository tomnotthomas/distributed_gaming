// Crews on the page: the Ask your PC friend card a signed-in player shares
// their link from, and the invite page the friend lands on.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskFriend, AskFriendStrip } from "./AskFriend";
import { CREW_COPY, crewText, langOf } from "./crewCopy";
import { Invite } from "./Invite";
import { inviteLink, inviteTokenAt, shareTarget, signInForInvite, withoutInviteTokens } from "./invite";
import { pathOf, screenAt } from "./route";
import type { Swiff } from "./useSwiff";

const TOKEN = "abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV";

/** A fetch answering each path from `routes`: a status and a JSON body. Every call is kept. */
function fetchFrom(routes: Record<string, [number, unknown] | (() => [number, unknown])>) {
  const calls: [string, string][] = [];
  const get = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([init?.method ?? "GET", url]);
    const route = routes[url];
    const [status, body] = typeof route === "function" ? route() : (route ?? [404, { error: "no" }]);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", get);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("crew copy", () => {
  it("has every key in German and English, and fills its slots", () => {
    expect(Object.keys(CREW_COPY.de).sort()).toEqual(Object.keys(CREW_COPY.en).sort());
    expect(crewText("en")("invite.kicker", { name: "Alex" })).toBe("Invited by Alex");
    expect(crewText("de")("ask.crew", { n: 3 })).toBe("3 in deiner Crew");
  });

  it("never sets a long dash", () => {
    for (const text of [...Object.values(CREW_COPY.en), ...Object.values(CREW_COPY.de)]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it("speaks German to a browser set to German, English to the rest", () => {
    expect(langOf(["de-AT", "en"])).toBe("de");
    expect(langOf(["en-GB", "de"])).toBe("de");
    expect(langOf(["fr-FR"])).toBe("en");
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
    expect(inviteLink(TOKEN, "https://swiff.example")).toBe(`https://swiff.example/invite/${TOKEN}`);
  });

  it("keeps the token out of the Steam round trip, remembering it in the tab", () => {
    expect(signInForInvite(TOKEN)).toBe("/auth/steam/login?to=%2Finvite");
    expect(sessionStorage.getItem("swiff.invite")).toBe(TOKEN);
  });

  it("cuts every invite token out of an analytics event, wherever it sits", () => {
    const timestamp = new Date(0);
    const event = {
      uuid: "u",
      event: "$autocapture",
      timestamp,
      properties: {
        $current_url: `https://swiff.example/invite/${TOKEN}?ref=wa`,
        $pathname: `/invite/${TOKEN}/`,
        $referrer: `https://swiff.example/invite/${TOKEN}`,
        $elements: [{ tag_name: "a", attr__href: `/auth/steam/login?to=%2Finvite%2F${TOKEN}` }],
        $elements_chain: `a:href="/invite/${TOKEN}"`,
        $screen_height: 900,
      },
      $set_once: { $initial_current_url: `https://swiff.example/invite/${TOKEN}` },
      $set: { $session_entry_url: `https://swiff.example/invite/${TOKEN}`, $other: "/invitee/x" },
    };
    const sent = withoutInviteTokens(event);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect(sent.properties.$current_url).toBe("https://swiff.example/invite?ref=wa");
    expect(sent.properties.$pathname).toBe("/invite/");
    expect(sent.properties.$elements[0]!.attr__href).toBe("/auth/steam/login?to=%2Finvite");
    expect(sent.$set_once.$initial_current_url).toBe("https://swiff.example/invite");
    expect(sent.$set.$other).toBe("/invitee/x");
    expect(sent.properties.$screen_height).toBe(900);
    expect(sent.timestamp).toBe(timestamp);
  });

  it("sends WhatsApp and email the message, and copies it for Discord and Steam chat", () => {
    expect(shareTarget("whatsapp", "play & host", "s")).toEqual({
      open: "https://wa.me/?text=play%20%26%20host",
    });
    expect(shareTarget("email", "m", "Host?")).toEqual({ open: "mailto:?subject=Host%3F&body=m" });
    expect(shareTarget("discord", "m", "s")).toEqual({ copy: "m" });
    expect(shareTarget("steam", "m", "s")).toEqual({ copy: "m" });
  });
});

describe("AskFriend", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  const MINE = { token: TOKEN, crew: { name: "Alex", own: true, size: 1 }, members: [], joined: [] };

  it("shows the player's personal link and copies it", async () => {
    fetchFrom({ "/api/me/invite": [200, MINE] });
    render(<AskFriend persona="Alex" />);
    const field = await screen.findByLabelText("Your invite link");
    expect(field).toHaveValue(`${location.origin}/invite/${TOKEN}`);
    expect(screen.getByText("Just you so far")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/invite/${TOKEN}`));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });

  it("opens WhatsApp with the message, and copies it for Discord with a note where to paste", async () => {
    fetchFrom({ "/api/me/invite": [200, MINE] });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<AskFriend persona="Alex" />);
    await screen.findByLabelText("Your invite link");

    fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const [url] = open.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/wa\.me\/\?text=Alex%20wants%20to%20play/);
    expect(decodeURIComponent(String(url))).toContain(`/invite/${TOKEN}`);

    fireEvent.click(screen.getByRole("button", { name: "Discord" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`/invite/${TOKEN}`)));
    expect(await screen.findByText("Message copied. Paste it in Discord.")).toBeInTheDocument();
  });

  it("offers the phone's own share sheet only where the browser has one", async () => {
    fetchFrom({ "/api/me/invite": [200, MINE] });
    render(<AskFriend persona="Alex" />);
    await screen.findByLabelText("Your invite link");
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();

    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      render(<AskFriend persona="Alex" />);
      const [button] = await screen.findAllByRole("button", { name: "Share" });
      fireEvent.click(button!);
      await waitFor(() =>
        expect(share).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(TOKEN) })),
      );
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it("makes a new link that replaces the old one", async () => {
    const calls = fetchFrom({
      "/api/me/invite": [200, MINE],
      "/api/me/invite/renew": [200, { ...MINE, token: TOKEN.toLowerCase() }],
    });
    render(<AskFriend persona="Alex" />);
    await screen.findByLabelText("Your invite link");
    fireEvent.click(screen.getByRole("button", { name: "Make a new link" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Your invite link")).toHaveValue(
        `${location.origin}/invite/${TOKEN.toLowerCase()}`,
      ),
    );
    expect(calls).toContainEqual(["POST", "/api/me/invite/renew"]);
  });

  it("says so when the link cannot be had, and tries again", async () => {
    let answer: [number, unknown] = [500, {}];
    fetchFrom({ "/api/me/invite": () => answer });
    render(<AskFriend persona="Alex" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your link could not be loaded.");
    answer = [200, MINE];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Your invite link")).toBeInTheDocument();
  });

  it("lists the crew by name, lets the owner remove a member, and leaves a crew the player joined", async () => {
    let mine = {
      ...MINE,
      crew: { ...MINE.crew, size: 3 },
      members: [
        { id: "m-sam", name: "Sam" },
        { id: "m-anon", name: null },
      ],
      joined: [{ id: "m-mine", name: "Jo", own: false, size: 2 }],
    };
    const calls = fetchFrom({
      "/api/me/invite": () => [200, mine],
      "/api/crew-members/m-sam/remove": () => {
        mine = { ...mine, crew: { ...mine.crew, size: 2 }, members: [{ id: "m-anon", name: null }] };
        return [200, { removed: true }];
      },
      "/api/crew-members/m-mine/remove": () => {
        mine = { ...mine, joined: [] };
        return [200, { removed: true }];
      },
    });
    render(<AskFriend persona="Alex" />);
    expect(await screen.findByText("Sam")).toBeInTheDocument();
    expect(screen.getByText("A crewmate")).toBeInTheDocument();
    expect(screen.getByText("Jo's crew")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
    await waitFor(() => expect(screen.queryByText("Sam")).toBeNull());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-sam/remove"]);
    expect(screen.getByText("2 in your crew")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Leave Jo's crew" }));
    await waitFor(() => expect(screen.queryByText("Crews you're in")).toBeNull());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-mine/remove"]);
  });

  it("says so when a member could not be removed", async () => {
    fetchFrom({ "/api/me/invite": [200, { ...MINE, members: [{ id: "m-sam", name: "Sam" }] }] });
    render(<AskFriend persona="Alex" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam" }));
    expect(await screen.findByText("That did not work. Try again.")).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
  });

  it("puts the wall's strip away for good once the player says not now", () => {
    const onOpen = vi.fn();
    const { unmount } = render(<AskFriendStrip onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask your PC friend" }));
    expect(onOpen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("ask-strip")).toBeNull();
    unmount();
    render(<AskFriendStrip onOpen={onOpen} />);
    expect(screen.queryByTestId("ask-strip")).toBeNull();
  });
});

describe("Invite", () => {
  const swiffAs = (signedIn: boolean) => ({ signedIn, goHome: vi.fn() }) as unknown as Swiff;
  const CREW = { name: "Alex", own: false, size: 1, member: false };

  beforeEach(() => history.replaceState(null, "", `/invite/${TOKEN}`));

  it("names who asked, and asks a signed-out friend to sign in with Steam first", async () => {
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: CREW }] });
    render(<Invite swiff={swiffAs(false)} />);
    expect(await screen.findByText("Invited by Alex")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Host Alex's crew");
    expect(screen.getByRole("link", { name: /Sign in with Steam/ })).toHaveAttribute(
      "href",
      "/auth/steam/login?to=%2Finvite",
    );
    expect(screen.queryByRole("button", { name: "Join the crew" })).toBeNull();
  });

  it("joins a signed-in friend to the crew, then leads on to the download", async () => {
    const calls = fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: CREW }],
      [`/api/invites/${TOKEN}/join`]: [200, { crew: { name: "Alex", own: false, size: 2 }, joined: true }],
    });
    render(<Invite swiff={swiffAs(true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Join the crew" }));
    expect(
      await screen.findByText("You're in Alex's crew. Your PC will host the crew only."),
    ).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", `/api/invites/${TOKEN}/join`]);
    expect(screen.getByRole("button", { name: /Download for Windows/ })).toBeDisabled();
    expect(screen.getByText("2 in the crew")).toBeInTheDocument();
    expect(document.querySelector("li[aria-current]")).toHaveTextContent("Download");
  });

  it("picks the invite up again at /invite, coming back from sign-in", async () => {
    sessionStorage.setItem("swiff.invite", TOKEN);
    history.replaceState(null, "", "/invite");
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: { ...CREW, member: true } }] });
    render(<Invite swiff={swiffAs(true)} />);
    expect(await screen.findByText("You're already in Alex's crew.")).toBeInTheDocument();
  });

  it("tells the inviter it is their own link", async () => {
    fetchFrom({ [`/api/invites/${TOKEN}`]: [200, { crew: { ...CREW, own: true, member: true } }] });
    render(<Invite swiff={swiffAs(true)} />);
    expect(await screen.findByText(/This is your own link/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join the crew" })).toBeNull();
    expect(screen.queryByText(/already in/)).toBeNull();
    expect(screen.queryByText(/Open it on the PC/)).toBeNull();
  });

  it("speaks of the crew, never a blank name, when Steam gave the inviter none", async () => {
    fetchFrom({
      [`/api/invites/${TOKEN}`]: [200, { crew: { ...CREW, name: null } }],
      [`/api/invites/${TOKEN}/join`]: [200, { crew: { name: null, own: false, size: 2 }, joined: true }],
    });
    render(<Invite swiff={swiffAs(true)} />);
    expect(await screen.findByText("You're invited")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Host your friend's crew");
    fireEvent.click(screen.getByRole("button", { name: "Join the crew" }));
    expect(
      await screen.findByText("You're in the crew. Your PC will host the crew only."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ 's|\?'s/);
  });

  it("says plainly when a link opens nothing any more", async () => {
    fetchFrom({});
    const swiff = swiffAs(false);
    render(<Invite swiff={swiff} />);
    expect(
      await screen.findByRole("heading", { name: "This invite link does not work any more." }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the wall" }));
    expect(swiff.goHome).toHaveBeenCalled();
  });

  it("offers to try again when the server gives no answer", async () => {
    let answer: [number, unknown] = [503, {}];
    fetchFrom({ [`/api/invites/${TOKEN}`]: () => answer });
    render(<Invite swiff={swiffAs(false)} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    answer = [200, { crew: CREW }];
    await act(async () => fireEvent.click(retry));
    expect(await screen.findByText("Invited by Alex")).toBeInTheDocument();
  });
});
