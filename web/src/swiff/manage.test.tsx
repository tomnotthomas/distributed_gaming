// Removing someone from a crew and taking a gaming PC out of one, on the crew
// page: only the founder gets the "…" next to someone, and both always ask
// first, with a confirmation that says what happens.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrewPage } from "./CrewPage";
import type { CrewDetail, CrewMember } from "./crews";
import { MANAGE_COPY } from "./manageCopy";
import { ScreenLang } from "./screenCopy";
import type { Swiff } from "./useSwiff";

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

const swiff = {
  signedIn: true,
  signInKnown: true,
  screen: "crew",
  crewRoute: { crew: "c1" },
  crewChanges: 0,
  crewReady: null,
  dismissCrewReady: vi.fn(),
  openCrew: vi.fn(),
  inviteShared: vi.fn(),
  games: [],
  crewLive: [],
  phase: "idle",
  taken: null,
  bookingFailed: false,
} as unknown as Swiff;

const LENA: CrewMember = {
  id: "m-lena",
  name: "Lena",
  you: true,
  admin: true,
  pc: null,
  pcs: 0,
  rsvp: "yes",
  next: null,
};
const TOM: CrewMember = { ...LENA, id: "m-tom", name: "Tom", you: false, admin: false, rsvp: null };
const JONAS: CrewMember = { ...TOM, id: "m-jonas", name: "Jonas", pc: "yes", pcs: 1 };
const session = () => ({ at: Date.now() + 2 * 86_400_000, yes: 1, no: 0 });

/** The Friday Squad as Lena, its founder, sees it: Tom and Jonas in, Jonas's PC playing for it. */
function squad(over: Partial<CrewDetail> = {}): CrewDetail {
  return {
    id: "c1",
    memberId: "m-lena",
    name: "Lena",
    crewName: "Friday Squad",
    own: true,
    size: 3,
    state: "ready",
    pcs: 1,
    session: session(),
    token: "abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV",
    members: [LENA, TOM, JONAS],
    machines: [
      { id: "q-j", name: "DESKTOP", owner: "Jonas", mine: false, state: "ready", games: [], playing: null },
    ],
    shared: true,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("removing someone from the crew", () => {
  it("lets the founder remove someone, only after the confirmation, and reads the crew again", async () => {
    let crew = squad();
    const calls = fetchFrom({
      "GET /api/crews/c1": () => [200, { crew }],
      "POST /api/crew-members/m-jonas/remove": () => {
        crew = squad({ size: 2, members: [LENA, TOM], machines: [], pcs: 0, state: "no-pc" });
        return [200, { removed: true }];
      },
    });
    render(<CrewPage swiff={swiff} />);
    expect(
      await screen.findByText("Only you can remove someone, because you founded the crew."),
    ).toBeInTheDocument();
    // Nobody removes themselves from here: no "…" on the founder's own row.
    expect(screen.queryByRole("button", { name: "More about Lena" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More about Jonas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from the crew" }));
    const ask = screen.getByRole("dialog", { name: "Remove Jonas from the crew?" });
    expect(ask).toHaveTextContent("Jonas won't see Friday Squad any more and won't get invites.");
    expect(ask).toHaveTextContent("Jonas's PC stops playing for the crew.");
    expect(ask).toHaveTextContent("Jonas can only come back with a new crew link from you.");
    expect(ask).toHaveTextContent("We don't send Jonas a message.");

    // Cancel removes nobody.
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter(([method]) => method === "POST")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "More about Jonas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from the crew" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Jonas" }));
    expect(await screen.findByText("Jonas is out of the crew.")).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crew-members/m-jonas/remove"]);
    await vi.waitFor(() => expect(screen.queryByText("Jonas")).toBeNull());
  });

  it("gives someone who did not found the crew no way to remove anyone", async () => {
    const crew = squad({
      own: false,
      memberId: "m-tom",
      members: [{ ...LENA, you: false }, { ...TOM, you: true }, JONAS],
    });
    fetchFrom({ "GET /api/crews/c1": [200, { crew }] });
    render(<CrewPage swiff={swiff} />);
    expect(await screen.findByText("Tom (you)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^More about/ })).toBeNull();
    expect(screen.queryByText("Only you can remove someone, because you founded the crew.")).toBeNull();
  });

  it("asks in German too", async () => {
    fetchFrom({ "GET /api/crews/c1": [200, { crew: squad() }] });
    render(
      <ScreenLang.Provider value="de">
        <CrewPage swiff={swiff} />
      </ScreenLang.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mehr zu Tom" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Aus der Crew entfernen" }));
    const ask = screen.getByRole("dialog", { name: "Tom aus der Crew entfernen?" });
    expect(ask).toHaveTextContent("Zurück kommt Tom nur mit einem neuen Crew-Link von dir.");
    expect(within(ask).getByRole("button", { name: "Tom entfernen" })).toBeInTheDocument();
  });
});

describe("taking a gaming PC out of a crew", () => {
  /** The squad as Jonas sees it: his PC plays for it and for Couch Co-op. */
  const hisSquad = () =>
    squad({
      own: false,
      memberId: "m-jonas",
      members: [{ ...LENA, you: false }, TOM, { ...JONAS, you: true }],
      machines: [{ ...squad().machines[0]!, mine: true }],
    });

  it("lists the crews the PC plays for, and takes it out of one only after the confirmation", async () => {
    const couch = { ...hisSquad(), id: "c2", crewName: "Couch Co-op", session: null };
    const calls = fetchFrom({
      "GET /api/crews/c1": [200, { crew: hisSquad() }],
      "GET /api/crews": [
        200,
        {
          crews: [
            { ...hisSquad(), pcArrived: false },
            { ...couch, pcArrived: false },
          ],
        },
      ],
      "GET /api/crews/c2": [200, { crew: couch }],
      "POST /api/crews/c1/pc": [
        200,
        { crew: { ...hisSquad(), pcs: 0, state: "no-pc", machines: [], members: hisSquad().members } },
      ],
    });
    render(<CrewPage swiff={swiff} />);
    const panel = (await screen.findByRole("heading", { name: "Your gaming PC" })).closest("section")!;
    expect(panel).toHaveTextContent("Jonas's PC plays for these crews");
    expect(await within(panel).findByText("Couch Co-op")).toBeInTheDocument();
    expect(panel).toHaveTextContent("Taking your PC out doesn't take you out. You stay in the crew.");

    fireEvent.click(within(panel).getAllByRole("button", { name: "Take it out of this crew" })[0]!);
    const ask = screen.getByRole("dialog", { name: "Take your PC out of Friday Squad?" });
    expect(ask).toHaveTextContent("Friday Squad can't play on your PC any more.");
    expect(ask).toHaveTextContent("then has no gaming PC. The others see that on the crew page.");
    expect(ask).toHaveTextContent("You stay in the crew. Couch Co-op keeps your PC.");
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it in" }));
    expect(calls.filter(([method]) => method === "POST")).toEqual([]);

    fireEvent.click(within(panel).getAllByRole("button", { name: "Take it out of this crew" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Take it out" }));
    expect(await screen.findByText("Your PC no longer plays for Friday Squad.")).toBeInTheDocument();
    expect(calls).toContainEqual(["POST", "/api/crews/c1/pc", '{"pc":"off"}']);
  });
});

describe("remove and PC copy", () => {
  it("has every key in German and English, with the same slots, and never a long dash", () => {
    const keys = Object.keys(MANAGE_COPY.en) as (keyof typeof MANAGE_COPY.en)[];
    expect(Object.keys(MANAGE_COPY.de).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(slots(MANAGE_COPY.de[key])).toEqual(slots(MANAGE_COPY.en[key]));
      expect(MANAGE_COPY.en[key] + MANAGE_COPY.de[key]).not.toMatch(/[—–]/);
    }
  });
});
