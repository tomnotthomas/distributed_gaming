// The full-screen viewer and the crew's vote on who plays next: the viewer's
// controls (leave, sound, mic, the crew menu), asking to play a game, the
// vote ticket with its tally and timer, and the player's time to save.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrewDetail } from "./crews";
import { GAMES } from "./data";
import { STREAM_COPY, streamText } from "./streamCopy";
import { askToPlay, clockOf, handOver, secondsLeft, voteSwitch, type SwitchView } from "./switch";
import { SwitchToast } from "./SwitchToast";
import type { Swiff } from "./useSwiff";
import { VoteTicket } from "./VoteTicket";
import type { WatchState } from "./watch";
import { Watch } from "./Viewer";

const watchMock = vi.hoisted(() => ({
  state: null as unknown as WatchState,
  session: {
    joinVoice: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setTalking: vi.fn(),
  },
}));
vi.mock("./watch", async (actual) => ({
  ...(await actual<typeof import("./watch")>()),
  useWatching: () => ({ state: watchMock.state, session: watchMock.session, muteForMe: vi.fn() }),
}));

type Route = [number, unknown];

/** A fetch answering "METHOD /path" from `routes`, keeping every call with its body. */
function fetchFrom(routes: Record<string, Route | (() => Route)>) {
  const calls: [string, string, string?][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(init?.body === undefined ? [method, url] : [method, url, String(init.body)]);
      const route = routes[`${method} ${url}`];
      const [status, body] = typeof route === "function" ? route() : (route ?? [404, { error: "no" }]);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const [ER, CS, THIRD] = [GAMES[0]!, GAMES[1]!, GAMES[2]!];
const NOW = 1_800_000_000_000;

/** A vote as Lena sees it: Kemal asked to play Counter-Strike, 2 of 4 said yes, 42 seconds left. */
function voteOf(over: Partial<SwitchView> = {}): SwitchView {
  return {
    id: "v1",
    gameId: CS.appid,
    proposer: "Kemal",
    player: "Max",
    mine: false,
    playing: false,
    voters: 4,
    yes: 2,
    no: 0,
    vote: null,
    canVote: true,
    endsAt: NOW + 42_000,
    outcome: "open",
    switchAt: null,
    moreLeft: 2,
    now: NOW,
    ...over,
  };
}

const WATCHING: WatchState = {
  phase: "watching",
  player: "Max",
  playerHere: true,
  framed: true,
  muted: false,
  ended: null,
  roster: [
    { id: "player", name: "Max", mid: "1", inVoice: true, muted: false, mutedByPlayer: false },
    { id: "w1", name: "Lena", mid: null, inVoice: false, muted: false, mutedByPlayer: false },
    { id: "w2", name: "Kemal", mid: "3", inVoice: true, muted: true, mutedByPlayer: false },
  ],
  voice: {
    inVoice: false,
    muted: false,
    mode: "open",
    talking: false,
    micRefused: false,
    mutedByPlayer: false,
  },
  hushed: [],
};

/** Lena's crew, Max playing Elden Ring on Jonas's PC, which has Lena's three games on it. */
const CREW = {
  id: "c1",
  memberId: "m-lena",
  members: [
    { id: "m-lena", name: "Lena", you: true, admin: false, pc: null, pcs: 0, rsvp: null, next: null },
  ],
  machines: [
    {
      id: "q",
      name: null,
      owner: "Jonas",
      mine: false,
      state: "busy",
      games: [ER.appid, CS.appid, THIRD.appid],
      playing: {
        sessionId: "s1",
        player: "Max",
        you: false,
        gameId: ER.appid,
        startedAt: 1,
        starting: false,
      },
    },
  ],
} as unknown as CrewDetail;

function viewer(over: Record<string, unknown> = {}) {
  return {
    lang: "en",
    games: [
      { ...ER, hours: 10 },
      { ...CS, hours: 50 },
      { ...THIRD, hours: 1 },
    ],
    watching: {
      sessionId: "s1",
      starting: false,
      player: "Max",
      gameId: ER.appid,
      machine: "Jonas's PC",
      startedAt: 1,
      sharing: true,
      watching: 2,
      mine: { state: "watching" },
      crew: "c1",
    },
    stopWatching: vi.fn(),
    openCrew: vi.fn(),
    ...over,
  } as unknown as Swiff;
}

beforeEach(() => {
  watchMock.state = WATCHING;
  watchMock.session.joinVoice.mockClear();
  watchMock.session.setMuted.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the vote's client", () => {
  it("counts down in minutes and seconds, never below zero", () => {
    expect(clockOf(secondsLeft(NOW + 168_000, NOW))).toBe("2:48");
    expect(clockOf(secondsLeft(NOW + 41_200, NOW))).toBe("0:42");
    expect(clockOf(secondsLeft(NOW - 5_000, NOW))).toBe("0:00");
  });

  it("asks, votes and hands over with the right calls, and reads a refusal", async () => {
    const calls = fetchFrom({
      "POST /api/crew-live/s%201/switch": [201, { switch: voteOf() }],
      "POST /api/crew-live/s%201/vote": [409, { code: "closed" }],
      "POST /api/crew-live/s%201/handover": [200, { switch: voteOf({ outcome: "yes" }) }],
    });
    expect(await askToPlay("s 1", CS.appid)).toEqual({ ok: true, view: voteOf() });
    expect(await voteSwitch("s 1", false)).toEqual({ ok: false, status: 409 });
    expect((await handOver("s 1", "more")).ok).toBe(true);
    expect(calls).toEqual([
      ["POST", "/api/crew-live/s%201/switch", `{"gameId":${CS.appid}}`],
      ["POST", "/api/crew-live/s%201/vote", '{"yes":false}'],
      ["POST", "/api/crew-live/s%201/handover", '{"ask":"more"}'],
    ]);
  });
});

describe("the vote ticket", () => {
  const t = streamText("en");

  it("says who wants what, the tally and the time left, and votes", () => {
    const onVote = vi.fn(async () => {});
    render(<VoteTicket view={voteOf()} now={NOW} game={CS.title} player="Max" t={t} onVote={onVote} />);
    const ticket = screen.getByRole("dialog", { name: `Kemal wants to play ${CS.title} next` });
    expect(ticket).toHaveTextContent("Should Max hand over?");
    expect(ticket).toHaveTextContent("2 of 4 say yes");
    expect(ticket).toHaveTextContent("0:42 left");
    expect(ticket).toHaveTextContent(
      "Most votes win. Max can also just say yes, then you switch right away.",
    );
    fireEvent.click(within(ticket).getByRole("button", { name: "Yes, switch" }));
    expect(onVote).toHaveBeenCalledWith(true);
  });

  it("gives the one who asked no buttons, and tells the player their yes switches at once", () => {
    const { rerender } = render(
      <VoteTicket
        view={voteOf({ mine: true, vote: "yes" })}
        now={NOW}
        game={CS.title}
        player="Max"
        t={t}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: `You want to play ${CS.title} next` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes, switch" })).toBeNull();
    expect(screen.getByText("You said yes. Waiting for the others.")).toBeInTheDocument();

    rerender(
      <VoteTicket
        view={voteOf({ playing: true })}
        now={NOW}
        game={CS.title}
        player="Max"
        t={t}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByText("Do you want to hand over?")).toBeInTheDocument();
    expect(screen.getByText("Most votes win. If you say yes, you switch right away.")).toBeInTheDocument();
  });

  it("says what the crew decided", () => {
    const { rerender } = render(
      <VoteTicket
        view={voteOf({ outcome: "yes", switchAt: NOW + 168_000 })}
        now={NOW}
        game={CS.title}
        player="Max"
        t={t}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The crew voted: Kemal is next");
    expect(screen.getByRole("status")).toHaveTextContent("Max saves now. In 2:48 the gaming PC switches.");
    rerender(
      <VoteTicket
        view={voteOf({ outcome: "no" })}
        now={NOW}
        game={CS.title}
        player="Max"
        t={t}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The crew voted: Max keeps playing");
  });

  it("speaks German", () => {
    render(
      <VoteTicket
        view={voteOf()}
        now={NOW}
        game="Deadlock"
        player="Max"
        t={streamText("de")}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Kemal will als Nächstes Deadlock zocken" })).toHaveTextContent(
      "2 von 4 sind dafürnoch 0:42",
    );
    expect(screen.getByRole("button", { name: "Ja, wechseln" })).toBeInTheDocument();
  });
});

describe("the player's time to save", () => {
  it("counts down once the crew said yes, and switches now or takes two more minutes", async () => {
    const yes = voteOf({ playing: true, canVote: false, outcome: "yes", switchAt: NOW + 168_000 });
    const calls = fetchFrom({
      "GET /api/crew-live/s1/switch": [200, { switch: yes }],
      "POST /api/crew-live/s1/handover": [200, { switch: { ...yes, switchAt: NOW + 288_000, moreLeft: 1 } }],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    render(<SwitchToast swiff={viewer({ profile: { persona: "Max" } })} sessionId="s1" />);
    const toast = await screen.findByTestId("switch-save");
    expect(toast).toHaveTextContent("The crew voted: Kemal is next");
    expect(toast).toHaveTextContent("Save your game. In 2:48 the gaming PC switches to Kemal.");
    fireEvent.click(within(toast).getByRole("button", { name: "+2 minutes" }));
    await vi.waitFor(() => expect(toast).toHaveTextContent("In 4:48"));
    fireEvent.click(within(toast).getByRole("button", { name: "Saved, switch now" }));
    await vi.waitFor(() =>
      expect(calls).toContainEqual(["POST", "/api/crew-live/s1/handover", '{"ask":"now"}']),
    );
  });

  it("lets the player vote on an open ask", async () => {
    const open = voteOf({ playing: true, yes: 1 });
    const calls = fetchFrom({
      "GET /api/crew-live/s1/switch": [200, { switch: open }],
      "POST /api/crew-live/s1/vote": [200, { switch: { ...open, outcome: "yes", switchAt: NOW + 180_000 } }],
    });
    render(<SwitchToast swiff={viewer({ profile: { persona: "Max" } })} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, switch" }));
    expect(await screen.findByTestId("switch-save")).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crew-live/s1/vote", '{"yes":true}']);
  });
});

describe("the full-screen viewer", () => {
  it("says who plays what on whose PC, and leaves the stream", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: CREW }],
      "GET /api/crew-live/s1/switch": [200, { switch: null }],
    });
    const swiff = viewer();
    render(<Watch swiff={swiff} />);
    expect(await screen.findByText(`Max is playing ${ER.title}`)).toBeInTheDocument();
    expect(screen.getByText("on Jonas's PC · 2 watching")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave stream" }));
    expect(swiff.stopWatching).toHaveBeenCalled();
  });

  it("joins voice with the mic, then mutes it, and turns the sound off", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: CREW }],
      "GET /api/crew-live/s1/switch": [200, { switch: null }],
    });
    const { rerender } = render(<Watch swiff={viewer()} />);
    const bar = screen.getByTestId("watch-crew");
    fireEvent.click(within(bar).getByRole("button", { name: "Join voice" }));
    expect(watchMock.session.joinVoice).toHaveBeenCalled();
    watchMock.state = { ...WATCHING, voice: { ...WATCHING.voice, inVoice: true } };
    rerender(<Watch swiff={viewer()} />);
    fireEvent.click(within(bar).getByRole("button", { name: "Mic on" }));
    expect(watchMock.session.setMuted).toHaveBeenCalledWith(true);
    fireEvent.click(within(bar).getByRole("button", { name: "Sound on" }));
    expect(within(bar).getByRole("button", { name: "Sound off" })).toBeInTheDocument();
    expect((screen.getByTestId("watch-video") as HTMLVideoElement).muted).toBe(true);
  });

  it("offers the viewer's own games on that PC, most played first, and asks the crew", async () => {
    let vote: SwitchView | null = null;
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: CREW }],
      "GET /api/crew-live/s1/switch": () => [200, { switch: vote }],
      "POST /api/crew-live/s1/switch": () => {
        vote = voteOf({
          mine: true,
          vote: "yes",
          yes: 1,
          proposer: "Lena",
          endsAt: Date.now() + 60_000,
          now: Date.now(),
        });
        return [201, { switch: vote }];
      },
    });
    render(<Watch swiff={viewer()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "I want to play" }));
    const sheet = await screen.findByRole("dialog", { name: "What do you want to play?" });
    expect(sheet).toHaveTextContent("If most say yes, you're next, and Max gets 3 minutes to save.");
    // Not the game being played; the most played first, picked.
    expect(
      within(sheet)
        .getAllByRole("button", { pressed: false })
        .map((b) => b.textContent),
    ).toEqual([THIRD.title]);
    expect(within(sheet).getByRole("button", { pressed: true })).toHaveTextContent(CS.title);
    fireEvent.click(within(sheet).getByRole("button", { name: "Ask the crew" }));
    expect(
      await screen.findByRole("dialog", { name: `You want to play ${CS.title} next` }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crew-live/s1/switch", `{"gameId":${CS.appid}}`]);
    // While the crew decides, nobody else asks.
    fireEvent.click(screen.getByRole("button", { name: "I want to play" }));
    expect(screen.getByText("The crew is already voting on who plays next.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "What do you want to play?" })).toBeNull();
  });

  it("keeps the crew within reach: who is here, the crew page, and leaving the crew after asking", async () => {
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: CREW }],
      "GET /api/crew-live/s1/switch": [200, { switch: null }],
      "POST /api/crew-members/m-lena/remove": [200, { removed: true }],
    });
    const swiff = viewer();
    render(<Watch swiff={swiff} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Who's here" }));
    const who = screen.getByRole("group", { name: "Who's here" });
    expect(who).toHaveTextContent("Maxplays");
    expect(who).toHaveTextContent("Kemal");

    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Leave the crew" }));
    expect(screen.getByRole("group", { name: "Leave the crew?" })).toBeInTheDocument();
    expect(calls.filter(([method]) => method === "POST")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await vi.waitFor(() => expect(swiff.openCrew).toHaveBeenCalledWith());
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-lena/remove"]);

    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Back to the crew page" }));
    expect(swiff.openCrew).toHaveBeenLastCalledWith("c1");
  });

  it("sends the one the crew chose to the crew page once the session is over", async () => {
    fetchFrom({
      "GET /api/crews/c1": [200, { crew: CREW }],
      "GET /api/crew-live/s1/switch": [
        200,
        { switch: voteOf({ mine: true, outcome: "yes", switchAt: NOW }) },
      ],
    });
    const swiff = viewer();
    const { rerender } = render(<Watch swiff={swiff} />);
    await act(async () => {});
    watchMock.state = { ...WATCHING, phase: "over", ended: "watch-ended" };
    rerender(<Watch swiff={swiff} />);
    expect(screen.getByTestId("watch-wait")).toHaveTextContent(
      `Your turn: start ${CS.title} on the crew page.`,
    );
    fireEvent.click(screen.getByRole("button", { name: "To the crew page" }));
    expect(swiff.openCrew).toHaveBeenCalledWith("c1");
  });

  it("says why a watch is over, in German too", () => {
    fetchFrom({});
    watchMock.state = { ...WATCHING, phase: "over", ended: "watch-stopped" };
    render(<Watch swiff={viewer({ lang: "de" })} />);
    expect(screen.getByTestId("watch-wait")).toHaveTextContent("Max teilt nicht mehr mit dir.");
    expect(screen.getByRole("button", { name: "Zurück" })).toBeInTheDocument();
  });
});

describe("viewer copy", () => {
  it("has every key in German and English, fills only known slots, and never sets a long dash", () => {
    const keys = Object.keys(STREAM_COPY.en) as (keyof typeof STREAM_COPY.en)[];
    expect(Object.keys(STREAM_COPY.de).sort()).toEqual([...keys].sort());
    const known = ["name", "game", "pc", "n", "of", "time", "player", "possessive"];
    for (const key of keys) {
      for (const text of [STREAM_COPY.en[key], STREAM_COPY.de[key]]) {
        for (const [, slot] of text.matchAll(/\{(\w+)\}/g)) expect(known).toContain(slot);
        expect(text).not.toMatch(/[—–]/);
      }
    }
  });
});
