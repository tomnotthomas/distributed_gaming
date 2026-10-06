// One language per screen: the top bar, the wall and the crew screens under it
// all speak the browser's language, German or English, never both at once.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chrome } from "./Chrome";
import { CREW_COPY, type Lang } from "./crewCopy";
import { CrewInvite } from "./CrewInvite";
import { GAMES, MACHINES, type Game, type SeedMachine } from "./data";
import { DEFAULT_PREFS, demoNow, seedSpots } from "./derive";
import { SCREEN_COPY, screenText } from "./screenCopy";
import { applySteam, type SteamProfile } from "./steam";
import type { Swiff } from "./useSwiff";
import { Wall } from "./Wall";

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

/** The page speaks `lang` only: no piece of the other language's copy, and no time of day. */
function expectOnly(lang: Lang) {
  const text = pageWords();
  const foreign = onlyIn(lang === "de" ? "en" : "de").filter((piece) => text.includes(piece));
  expect(foreign).toEqual([]);
  expect(text).not.toMatch(/tonight/i);
}

function browserIn(lang: Lang) {
  const tag = lang === "de" ? "de-DE" : "en-GB";
  vi.stubGlobal("navigator", { ...navigator, languages: [tag], language: tag });
}

/** Every request answered: the invite to Alex's crew, the renter's crews (none yet), anything else a 404. */
function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const [status, body] =
        url === `/api/invites/${TOKEN}`
          ? [
              200,
              {
                crew: {
                  name: "Alex",
                  crewName: null,
                  own: false,
                  size: 1,
                  state: "no-pc",
                  pcs: 0,
                  member: false,
                },
              },
            ]
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
  } as unknown as Swiff;
}

/** The top bar as a signed-in renter sees it, with its live count, over `body`. */
function signedInScreen(lang: Lang, body: React.ReactNode, signedIn = true) {
  const t = screenText(lang);
  render(
    <>
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
    </>,
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

describe("screen copy", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(SCREEN_COPY.de).sort()).toEqual(Object.keys(SCREEN_COPY.en).sort());
  });

  it("calls the session length play time, not a time of day", () => {
    expect(screenText("en")("bar.playTime")).toBe("Play time");
    expect(screenText("de")("bar.playTime")).toBe("Spielzeit");
  });
});
