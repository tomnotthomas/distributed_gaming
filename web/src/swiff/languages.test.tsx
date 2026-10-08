// One language per screen: a translated screen (the wall, an invite, a seat,
// the crew pages) speaks the browser's language, every other screen English,
// and all on it with it: the top bar, the crew card and banner, the dialogs, Ignition.

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chrome } from "./Chrome";
import { CREW_COPY, type Lang } from "./crewCopy";
import { CrewInvite } from "./CrewInvite";
import { GAMES, MACHINES, type Game, type SeedMachine } from "./data";
import { DEFAULT_PREFS, demoNow, seedSpots } from "./derive";
import { Ignition } from "./Ignition";
import { ignitionLabels } from "./play";
import { MachineLost, Reconnecting } from "./Reconnect";
import { SCREEN_COPY, ScreenLang, screenLang, screenText } from "./screenCopy";
import { applySteam, type SteamProfile } from "./steam";
import { Swiff as App } from "./Swiff";
import type { Screen as AppScreen, Swiff } from "./useSwiff";
import { Wall } from "./Wall";

vi.mock("../posthog", () => ({ default: { capture: () => {} }, isPostHogEnabled: false }));

const TOKEN = "abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV";
const noop = () => {};

const words = (lang: Lang) =>
  [...Object.values(CREW_COPY[lang]), ...Object.values(SCREEN_COPY[lang])] as string[];

/**
 * The pieces of `lang`'s copy that only `lang` says: each string cut at its
 * slots, leaving out pieces the other language says too ("Crew", "Steam").
 */
function onlyIn(lang: Lang): string[] {
  const other = words(lang === "de" ? "en" : "de");
  return words(lang)
    .flatMap((text) => text.split(/\{\w+\}/))
    .map((piece) => piece.trim().replace(/^[.,]\s*|\s*[.,]$/g, ""))
    .filter((piece) => piece.length >= 3 && !other.some((text) => text.includes(piece)));
}

/** Everything a person reads or hears on the page: its text, labels and tooltips. */
function pageWords(): string {
  const attrs = [...document.querySelectorAll("[aria-label], [title]")].flatMap((el) => [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
  ]);
  return [document.body.textContent ?? "", ...attrs].join("\n");
}

/** The page speaks `lang` only: no piece of the other language's copy, and no time of day (tonight, Abend). */
function expectOnly(lang: Lang) {
  const text = pageWords();
  const foreign = onlyIn(lang === "de" ? "en" : "de").filter((piece) => text.includes(piece));
  expect(foreign).toEqual([]);
  expect(text).not.toMatch(/tonight|abend/i);
}

function browserIn(lang: Lang) {
  const tag = lang === "de" ? "de-DE" : "en-GB";
  vi.stubGlobal("navigator", { ...navigator, languages: [tag], language: tag });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
  }));
  Element.prototype.scrollTo ??= noop;
}

/**
 * Every request answered: the invite to Alex's crew, Lena's seat for kai_nx,
 * kai_nx signed in, the renter's crews (none yet), each of `more` as it says,
 * anything else a 404.
 */
function serve(more: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const [status, body] = Object.hasOwn(more, url)
        ? [200, more[url]]
        : url === `/api/invites/${TOKEN}`
          ? [
              200,
              {
                crew: {
                  name: "Alex",
                  crewName: null,
                  own: false,
                  size: 2,
                  state: "no-pc",
                  pcs: 0,
                  member: false,
                  session: { at: Date.now() + 86_400_000, yes: 1, no: 1 },
                  guests: [
                    { name: "Alex", admin: true, rsvp: "yes" },
                    { name: "Sam", admin: false, rsvp: "no" },
                  ],
                },
              },
            ]
          : url === `/api/seats/${TOKEN}`
            ? [
                200,
                {
                  seat: {
                    host: "Lena",
                    friend: "kai_nx",
                    number: 2,
                    of: 3,
                    state: "open",
                    expiresAt: Date.now() + 12 * 24 * 60 * 60_000,
                    pc: { name: "Nova-01", gpu: "Radeon RX 7900 XT", state: "ready", rentalMode: true },
                    crewId: null,
                  },
                },
              ]
            : url === "/api/me"
              ? [200, { steamId: "76561198000000001", profile }]
              : url === "/api/crews"
                ? [200, { crews: [] }]
                : [404, { error: "no" }];
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

const profile: SteamProfile = {
  id: "0001",
  persona: "kai_nx",
  avatar: "",
  hours: 0,
  size: 0,
  owned: [[1245620, 12]],
  games: [],
  lib: true,
};
const pool = ["glass", "ember", "tide", "moss"];

function swiffOn(games: Game[], machines: Record<string, SeedMachine>, signedIn: boolean): Swiff {
  return {
    demo: false,
    motion: false,
    games,
    profile: signedIn ? profile : null,
    signedIn,
    libraryRetrying: false,
    retryLibrary: noop,
    spots: seedSpots(games, machines, "evening", DEFAULT_PREFS),
    freed: new Set(),
    clock: demoNow(),
    showAll: true,
    hoverId: null,
    steamDenied: false,
    openGame: noop,
    setHoverId: noop,
    setShowAll: noop,
    setScreen: noop,
    goHome: noop,
    crewLive: [],
    watch: noop,
  } as unknown as Swiff;
}

/** The top bar as a signed-in renter sees it, with its live count, over `body`, all on a screen in `lang`. */
function signedInScreen(lang: Lang, body: ReactNode, signedIn = true) {
  const t = screenText(lang);
  render(
    <ScreenLang.Provider value={lang}>
      <Chrome
        screen="home"
        onHome={noop}
        onProfile={noop}
        onShare={noop}
        live={signedIn ? t("live.ready", { n: 0 }) : undefined}
        renter={
          signedIn
            ? { persona: "kai_nx", session: { label: t("session.evening"), onCycle: noop } }
            : undefined
        }
      />
      {body}
    </ScreenLang.Provider>,
  );
}

const busy = Object.fromEntries(Object.entries(MACHINES).map(([id, m]) => [id, { ...m, busy: true }]));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe.each(["de", "en"] as const)("a browser in %s", (lang) => {
  it("sees one language on the signed-in home with nothing ready: bar, wall and crew card", async () => {
    browserIn(lang);
    serve();
    const games = applySteam(profile, pool);
    signedInScreen(lang, <Wall swiff={swiffOn(games, busy, true)} />);
    expect(
      await screen.findByText(lang === "de" ? "Gerade ist nichts bereit" : "Nothing is ready right now"),
    ).toBeInTheDocument();
    expect(await screen.findByText(lang === "de" ? "Deine Crews" : "Your crews")).toBeInTheDocument();
    expectOnly(lang);
  });

  it("sees one language on the signed-in home with a game ready: bar, hero, band and crew strip", () => {
    browserIn(lang);
    serve();
    signedInScreen(lang, <Wall swiff={swiffOn(applySteam(profile, pool), MACHINES, true)} />);
    expect(screen.getByTestId("hero")).toBeInTheDocument();
    expect(screen.getByTestId("crew-strip")).toBeInTheDocument();
    expectOnly(lang);
  });

  it("sees one language on the signed-out wall", () => {
    browserIn(lang);
    signedInScreen(lang, <Wall swiff={swiffOn(GAMES, MACHINES, false)} />, false);
    expect(
      screen.getByRole("link", { name: lang === "de" ? "Mit Steam anmelden" : "Sign in with Steam" }),
    ).toBeInTheDocument();
    expectOnly(lang);
  });

  it.each([false, true])("sees one language on /invite/<token> (signed in: %s)", async (signedIn) => {
    browserIn(lang);
    serve();
    history.replaceState(null, "", `/invite/${TOKEN}`);
    signedInScreen(lang, <CrewInvite swiff={swiffOn([], MACHINES, signedIn)} />, signedIn);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Alex");
    expectOnly(lang);
  });
});

/** A crew the renter is in got its first PC since their last visit: the banner shows on every screen. */
const READY_CREW = {
  id: "c1",
  memberId: "m",
  name: "Lena",
  crewName: null,
  own: false,
  size: 2,
  state: "ready",
  pcs: 1,
  pcArrived: true,
};

/** b-1, Counter-Strike 2: still running on Glasshouse after the page closed, or queued for a machine. */
const booking = (status: "playing" | "queued") => ({
  bookingId: "b-1",
  status,
  gameId: 730,
  minutes: 180,
  ...(status === "playing"
    ? {
        machine: { id: "h1", name: "Glasshouse", gpu: null, cpu: null, price: 0 },
        sessionId: "s-1",
        heldUntil: Date.now() + 100_000,
      }
    : {}),
});

/** The dialogs a page load can open over any screen, and what the page kept for each. */
const DIALOGS = {
  away: () =>
    localStorage.setItem(
      "swiff.play",
      JSON.stringify({ bookingId: "b-1", sessionId: "s-1", roomId: "pc-1" }),
    ),
  "queue-back": () => localStorage.setItem("swiff.booking", "b-1"),
} as const;

/** Each player screen: the address it opens at, or the top bar's button that leads to it from the wall. */
const SCREENS: { screen: AppScreen; path: string; via?: "bar.profile" }[] = [
  { screen: "home", path: "/" },
  { screen: "invite", path: `/invite/${TOKEN}` },
  { screen: "seat", path: `/seat/${TOKEN}` },
  { screen: "crew", path: "/crews/c-other" },
  { screen: "share", path: "/share" },
  { screen: "profile", path: "/", via: "bar.profile" },
];

describe.each(["de", "en"] as const)("the whole app in a browser in %s", (lang) => {
  describe.each(SCREENS)("on $screen", ({ screen: shown, path, via }) => {
    const expected = screenLang(shown, lang);

    it.each(Object.keys(DIALOGS) as (keyof typeof DIALOGS)[])(
      "speaks one language, with the crew banner and the %s dialog over it",
      async (dialog) => {
        browserIn(lang);
        vi.stubGlobal(
          "EventSource",
          class {
            addEventListener(type: string, listener: (event: Event) => void) {
              if (type !== "booking") return;
              const data = JSON.stringify(booking(dialog === "away" ? "playing" : "queued"));
              queueMicrotask(() => listener(new MessageEvent("booking", { data })));
            }
            close() {}
          },
        );
        DIALOGS[dialog]();
        serve({
          "/api/crews": { crews: [READY_CREW] },
          "/api/bookings/b-1": booking(dialog === "away" ? "playing" : "queued"),
        });
        history.replaceState(null, "", path);
        render(<App />);
        await screen.findByText("kai_nx");
        if (via) fireEvent.click(screen.getByRole("button", { name: screenText(lang)(via) }));
        expect(document.querySelector(".sw")).toHaveAttribute("data-screen", shown);
        await screen.findByTestId("crew-ready");
        await screen.findByTestId(dialog);
        const t = screenText(expected);
        const nav = screen.getByRole("navigation", { name: "Lanterel" });
        expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
          t("bar.home"),
          t("bar.profile"),
          t("bar.share"),
        ]);
        expect(screen.getByTitle(t("bar.playTimeTitle")).querySelector("b")?.textContent).toBeOneOf(
          (["quick", "evening", "night"] as const).map((s) => t(`session.${s}`)),
        );
        expectOnly(expected);
      },
    );
  });

  it("counts what is free in the bar's language: the browser's over the wall, English over the estimate", async () => {
    browserIn(lang);
    serve();
    history.replaceState(null, "", "/?demo=1");
    const { unmount } = render(<App />);
    let nav = await screen.findByRole("navigation", { name: "Lanterel" });
    expect(nav).toHaveTextContent(new RegExp(screenText(lang)("live.near", { n: "\\d+" })));
    expectOnly(lang);
    unmount();

    history.replaceState(null, "", "/share?demo=1");
    render(<App />);
    nav = await screen.findByRole("navigation", { name: "Lanterel" });
    expect(nav).toHaveTextContent(new RegExp(screenText("en")("live.near", { n: "\\d+" })));
    expectOnly("en");
  });
});

describe.each(["de", "en"] as const)("the overlays on a screen in %s", (lang) => {
  const t = screenText(lang);
  const onScreen = (node: ReactNode) =>
    render(<ScreenLang.Provider value={lang}>{node}</ScreenLang.Provider>);
  const starting = (more: Record<string, unknown>) =>
    ({
      game: GAMES[0],
      picked: MACHINES.glass,
      progress: 0.3,
      ignitionSteps: ignitionLabels(t, MACHINES.glass!.name, GAMES[0]!.title),
      ignitionIndex: 1,
      slow: false,
      lost: null,
      goHome: noop,
      tryAnother: noop,
      ...more,
    }) as unknown as Swiff;

  it("speaks one language in Ignition, taking long, after a lost machine", () => {
    onScreen(
      <Ignition
        swiff={starting({
          slow: true,
          lost: { host: "Basement rig", taken: true },
        })}
      />,
    );
    expect(screen.getByTestId("ignition-slow")).toBeInTheDocument();
    expectOnly(lang);
  });

  it("speaks one language in Steam's sign-in code, and in each way it stops short", () => {
    const { unmount } = onScreen(
      <Ignition
        swiff={starting({ steamLogin: { type: "steam-login", state: "qr", url: "https://s.team/q/1/123" } })}
      />,
    );
    expect(screen.getByTestId("steam-sign-in")).toBeInTheDocument();
    expectOnly(lang);
    unmount();
    for (const reason of ["launch-timeout", "time-up", "not-approved"]) {
      const { unmount } = onScreen(<Ignition swiff={starting({ steamSignInFailed: reason })} />);
      expect(screen.getByTestId("steam-sign-in-failed")).toBeInTheDocument();
      expectOnly(lang);
      unmount();
    }
  });

  it("speaks one language when the machine is lost: moving, waiting, or with none to move to", () => {
    const lost = { booking: { gameId: GAMES[0]!.appid }, host: "Basement rig", at: Date.now() };
    for (const state of [
      { taken: false, failed: false, next: null },
      { taken: true, failed: false, next: { status: "queued" } },
      { taken: false, failed: true, next: null },
    ]) {
      const { unmount } = onScreen(
        <MachineLost swiff={{ games: GAMES, lost: { ...lost, ...state } } as unknown as Swiff} />,
      );
      expect(screen.getByTestId("machine-lost")).toBeInTheDocument();
      expectOnly(lang);
      unmount();
    }
  });

  it("speaks one language while reconnecting, and once it gave up", () => {
    for (const gaveUp of [false, true]) {
      const play = { lostAt: Date.now(), droppedAt: Date.now(), gaveUp };
      const { unmount } = onScreen(
        <Reconnecting swiff={{ game: GAMES[0], play } as unknown as Swiff} host="Glasshouse" />,
      );
      expect(screen.getByTestId("reconnecting")).toBeInTheDocument();
      expectOnly(lang);
      unmount();
    }
  });
});

describe("screen copy", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(SCREEN_COPY.de).sort()).toEqual(Object.keys(SCREEN_COPY.en).sort());
  });

  it("calls the session length play time, not a time of day", () => {
    expect(screenText("en")("bar.playTime")).toBe("Play time");
    expect(screenText("de")("bar.playTime")).toBe("Spielzeit");
  });
});
