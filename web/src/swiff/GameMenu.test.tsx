import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, demoNow, machinesFor, reason } from "./derive";
import { GAMES, MACHINES, type Machine } from "./data";
import { GameMenu } from "./GameMenu";
import { machinesOf } from "./live";
import type { Swiff } from "./useSwiff";

const noop = () => {};

/** Baldur's Gate 3 runs on Tide (free) and Moss (busy until 21:30). */
const bg3 = GAMES.find((game) => game.id === "bg3")!;
const machines = machinesFor(bg3, MACHINES, "evening");

/** Just the slice of the hook the game page reads, on the demo machines unless `over` says otherwise. */
const swiffWith = (phase: Swiff["phase"], signedIn = true, over: Partial<Swiff> = {}) =>
  ({
    signedIn,
    seesAvailability: true,
    machinesLoading: false,
    game: bg3,
    machines,
    reason: reason(bg3, MACHINES, "evening"),
    picked: MACHINES.tide,
    clock: demoNow(),
    phase,
    ...DEFAULT_PREFS,
    launch: noop,
    setMachineId: noop,
    ...over,
  }) as unknown as Swiff;

/** Two real hosts as the server ranks them for a game, and one busy until 23:10. */
const now = new Date(2026, 9, 3, 21, 0).getTime();
const hosts: Machine[] = machinesOf(
  {
    appid: bg3.appid,
    minutes: 180,
    machines: [
      {
        id: "h1",
        name: "Basement rig",
        gpu: "NVIDIA GeForce RTX 4070",
        cpu: "Ryzen 7 7700",
        refreshHz: 144,
        availableUntil: null,
        minutesLeft: null,
        coversSession: true,
        latency: { rttMs: 22.6, jitterMs: 2, source: "estimate" },
        response: 3,
        picture: 3,
      },
      {
        id: "h2",
        name: null,
        gpu: "NVIDIA GeForce RTX 3080",
        cpu: "Core i7-12700K",
        refreshHz: 60,
        availableUntil: now + 90 * 60_000,
        minutesLeft: 90,
        coversSession: false,
        latency: { rttMs: 40, jitterMs: 4, source: "estimate" },
        response: 2,
        picture: 2,
      },
    ],
    reason: { rule: "O1", label: "Free all session" },
    busy: [{ id: "h3", name: "Loft", backAt: new Date(2026, 9, 3, 23, 10).getTime() }],
  },
  now,
);

describe("GameMenu", () => {
  it("counts the players behind the listed machines, not the busy one left out", () => {
    render(<GameMenu swiff={swiffWith("idle")} />);

    expect(screen.getByText(/1 PC from 1 player/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 back at 21:30/)).toBeInTheDocument();
  });

  it("will not take a second hold while the launch is under way", () => {
    render(<GameMenu swiff={swiffWith("connecting")} />);

    expect(screen.getByRole("button", { name: "Hold to launch on Tide" })).toBeDisabled();
  });

  it("asks a signed-out visitor to sign in with Steam instead of offering a launch", () => {
    const { container } = render(<GameMenu swiff={swiffWith("idle", false)} />);

    expect(screen.queryByRole("button", { name: /hold to launch/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in with Steam" })).toHaveAttribute(
      "href",
      "/auth/steam/login",
    );
    // The machines can still be compared before signing in.
    expect(screen.getByRole("button", { name: /Tide/ })).toBeEnabled();
    expect(container.querySelector("video")).toBeNull();
  });

  describe("on the real hosts", () => {
    it("shows a signed-out visitor no machines, only the way to see them", () => {
      const { container } = render(
        <GameMenu
          swiff={swiffWith("idle", false, { seesAvailability: false, machines: [], picked: null })}
        />,
      );
      expect(container.querySelectorAll(".ledger-row")).toHaveLength(0);
      expect(screen.getByText(/Sign in to see which PCs can play it/)).toBeInTheDocument();
      expect(screen.queryAllByText(/back at|free until|PCs? from/)).toHaveLength(0);
      expect(screen.getByRole("link", { name: "Sign in with Steam" })).toBeInTheDocument();
    });

    it("lists the hosts as the server ranked them, with its reason, and never who owns them", () => {
      const swiff = swiffWith("idle", true, {
        machines: hosts,
        picked: hosts[0]!,
        reason: "Free all session",
        clock: now,
      });
      const { container } = render(<GameMenu swiff={swiff} />);
      expect(screen.getByText("2 PCs")).toBeInTheDocument();
      const rows = [...container.querySelectorAll(".ledger-row")];
      expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["Basement rig", "A shared PC"]);
      expect(rows[0]).toHaveTextContent("Free all session");
      expect(rows[0]).toHaveTextContent("Ryzen 7 7700, NVIDIA GeForce RTX 4070");
      expect(rows[0]).toHaveTextContent("12 h+");
      expect(rows[1]).toHaveTextContent("1080p 60");
      expect(rows[1]).toHaveTextContent("1 h 30 left");
      expect(screen.getByText("+1 back at 23:10")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hold to launch on Basement rig" })).toBeEnabled();
    });

    it("leaves a host whose offer has passed since it was read no time, not 12 h+", () => {
      const swiff = swiffWith("idle", true, { machines: hosts, picked: hosts[0]!, clock: now + 95 * 60_000 });
      const { container } = render(<GameMenu swiff={swiff} />);
      const rows = [...container.querySelectorAll(".ledger-row")];
      expect(rows[1]).toHaveTextContent("0 min left");
      expect(rows[1]).not.toHaveTextContent("12 h+");
    });

    it("says machines are being found until the server answers", () => {
      render(
        <GameMenu swiff={swiffWith("idle", true, { machines: [], picked: null, machinesLoading: true })} />,
      );
      expect(screen.getByText("Finding PCs…")).toBeInTheDocument();
      expect(screen.queryByText(/No PC can play it/)).toBeNull();
    });

    it("says so when no host can play it", () => {
      render(<GameMenu swiff={swiffWith("idle", true, { machines: [], picked: null })} />);
      expect(screen.getByText("No PC can play it right now.")).toBeInTheDocument();
    });

    it("says which launcher the game asks the renter to sign in to, and nothing when it asks for none", () => {
      const { unmount } = render(
        <GameMenu
          swiff={swiffWith("idle", true, { game: { ...bg3, signIn: "Needs your Ubisoft sign-in" } })}
        />,
      );
      expect(screen.getByText("Needs your Ubisoft sign-in")).toBeInTheDocument();
      unmount();
      render(<GameMenu swiff={swiffWith("idle", true)} />);
      expect(screen.queryByText(/sign-in$/)).toBeNull();
    });

    it("says in plain words when the server refuses a game the renter does not own", () => {
      render(<GameMenu swiff={swiffWith("idle", true, { bookingFailed: true, refusal: "not-owned" })} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/You don't own this game on Steam/);
      expect(screen.getByRole("alert")).toHaveTextContent(/free-to-play games can start/);
      expect(screen.queryByText(/Try again/)).toBeNull();
    });

    it("tells a renter whose library cannot be read how to make it public", () => {
      render(
        <GameMenu swiff={swiffWith("idle", true, { bookingFailed: true, refusal: "library-unreadable" })} />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(/We can't see your Steam library/);
      expect(screen.getByRole("alert")).toHaveTextContent(/Game details to Public/);
    });

    it("tells the renter when Swiff cannot run the game", () => {
      render(<GameMenu swiff={swiffWith("idle", true, { bookingFailed: true, refusal: "not-playable" })} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/can't run on Lanterel/);
      expect(screen.queryByText(/Try again/)).toBeNull();
    });

    it("keeps the plain retry for a booking call that failed for any other reason", () => {
      render(<GameMenu swiff={swiffWith("idle", true, { bookingFailed: true, refusal: null })} />);
      expect(screen.getByRole("alert")).toHaveTextContent("That didn't go through. Try again.");
    });
  });
});
