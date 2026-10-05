import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApp, Shell } from "./App";
import { DEMO_SCREENS, evening, type DemoScreen } from "./demo";
import type { Claim, Host, HostActions, HostView, Live, Step } from "./model";
import { HOLD_MS } from "./ui/hold";
import type { HostBridge } from "./bridge";
import { useRental } from "./useRental";
import { installPlan, rentalOf, TYPE, type RentalRead } from "../rental.cjs";
import FACTS from "./test/rental-facts.json";

const FAKE = [
  "setTimeout",
  "clearTimeout",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "performance",
] as const;

/** Let a held press run for `ms` of fake time, a frame at a time. */
const run = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** Press and hold a control until it fires. */
function hold(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0 });
  run(HOLD_MS + 100);
  fireEvent.pointerUp(window);
}

const CLAIM: Claim = { appid: 1245620, name: "ELDEN RING", minutes: 90, at: evening(21, 10), rate: null };

/** This PC's view, as useHost builds it: what the app reads and does, and nothing the platform does not report. */
function realView(live: Live, more: Partial<HostView> = {}): HostView {
  return {
    demo: false,
    now: evening(21, 30),
    machine: "gaming-pc-1",
    pc: {
      reading: false,
      hardware: {
        gpu: "NVIDIA GeForce RTX 4080",
        vramMb: 16_384,
        ramMb: 32_768,
        cpu: "Ryzen 7 7800X3D",
        cores: 8,
        encoders: ["h264", "hevc", "av1"],
        display: { width: 2560, height: 1440, refreshHz: 144 },
      },
      hardwareRate: null,
    },
    games: {
      installed: [
        { appid: 730, name: "Counter-Strike 2" },
        { appid: 1245620, name: "ELDEN RING" },
      ],
      offered: null,
      demand: null,
      near: null,
    },
    steam: {
      status: { installed: true, running: true, signedIn: true },
      installer: { kind: "idle" },
      installs: [],
      asked: [],
    },
    rental: { reading: false, read: null, target: null, preview: null },
    standing: null,
    earlyEnd: null,
    rate: null,
    earnings: null,
    live,
    plan: evening(1),
    sessionsToday: 1,
    connection: {
      url: "signal.example",
      machineId: "gaming-pc-1",
      machineKey: "test-machine-key",
      name: "",
      notice: null,
      preview: null,
    },
    payoutSaved: false,
    ...more,
  };
}

function actions(): HostActions {
  return {
    plan: vi.fn(),
    goLive: vi.fn(),
    setUntil: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setStopNew: vi.fn(),
    notifyAtEnd: vi.fn(),
    endEarly: null,
    cancelEnd: null,
    retry: vi.fn(),
    toggleOffer: vi.fn(),
    saveConnection: vi.fn(async () => {}),
    savePayout: vi.fn(),
    installSteam: vi.fn(),
    askInstall: vi.fn(),
    checkRental: vi.fn(),
    chooseRentalTarget: vi.fn(),
    previewRental: vi.fn(),
    closeRentalPreview: vi.fn(),
  };
}

/** The app on a fixed view of this PC, at `step`. */
function renderReal(step: Step, live: Live, more: Partial<HostView> = {}) {
  const host: Host = { view: realView(live, more), actions: actions() };
  render(<Shell host={host} step={step} onStep={vi.fn()} setupDone finishSetup={vi.fn()} />);
  return host.actions;
}

const off: Live = { kind: "off", note: null };
const session = (atPc: boolean): Live => ({
  kind: "session",
  since: evening(21),
  until: evening(1),
  claim: CLAIM,
  playerHere: true,
  stopNew: false,
  notify: false,
  atPc,
});

/** Nothing the platform does not report may appear on this PC's own screens. */
function expectNoDemoData() {
  expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/€/);
  expect(screen.queryByLabelText("Your standing")).not.toBeInTheDocument();
  expect(screen.queryByText(/looking/)).not.toBeInTheDocument();
}

describe("demo", () => {
  const HEADINGS: Record<Exclude<DemoScreen, "tray">, string> = {
    pc: "Reading this PC",
    steam: "Steam is ready",
    games: "Choose the games you offer",
    rental: "One change in the BIOS",
    golive: "Ready to share",
    waiting: "Waiting for a player",
    streaming: "Elden Ring",
    inuse: "Nova-01 is in use",
    ending: "Player warned",
    paused: "Paused",
    offline: "Offline",
    payout: "Where should we pay you?",
    paid: "This month",
    settings: "Connection",
  };

  it.each(DEMO_SCREENS.filter((s) => s.id !== "tray"))("shows $name, labelled as demo data", ({ id }) => {
    render(<DemoApp screen={id} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      HEADINGS[id as keyof typeof HEADINGS],
    );
    expect(screen.getByText("Demo data")).toBeInTheDocument();
  });

  it("shows the tray glance under a tray, labelled as demo data", () => {
    render(<DemoApp screen="tray" />);
    expect(screen.getByText("Elden Ring, protected until 22:40")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop new sessions" })).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
  });

  it("ranks the games by demand, with Install on Steam for the ones this PC lacks", () => {
    render(<DemoApp screen="games" />);
    expect(screen.getByText("38 looking")).toBeInTheDocument();
    const install = screen.getAllByRole("link", { name: /Install on Steam/ });
    expect(install.map((a) => a.getAttribute("href"))).toEqual(["steam://install/553850"]);
    expect(screen.getByRole("progressbar", { name: "Installing Baldur's Gate 3" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByText("Downloading 42%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Starfield/ }));
    expect(screen.getByRole("button", { name: /Starfield/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("5", { selector: ".gcount b" })).toBeInTheDocument();
  });

  it("builds the rate in the open", () => {
    render(<DemoApp screen="golive" />);
    const rate = screen.getByRole("heading", { name: "Your rate" }).closest("section")!;
    expect(rate).toHaveTextContent("Hardware, RTX 4080€1,00");
    expect(rate).toHaveTextContent("Reliability 96100%");
    expect(rate).toHaveTextContent("Level Steady+5%");
    expect(rate).toHaveTextContent("At most €4,20 tonight, if a player stays until 01:00.");
  });

  it("shows the month against a ceiling at the current rate, not a forecast", () => {
    render(<DemoApp screen="paid" />);
    // €1,05 an hour, six evening hours, thirty days in September.
    expect(screen.getByText(/this month at your current rate, if live every evening/)).toHaveTextContent(
      "Up to €189 this month at your current rate, if live every evening from 18:00 to midnight.",
    );
    expect(document.body.textContent).not.toMatch(/estimate/i);
  });

  describe("walked through", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...FAKE] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("goes live on a held press, pauses and resumes", () => {
      render(<DemoApp screen="golive" />);
      hold(screen.getByRole("button", { name: "Hold to go live" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Waiting for a player");

      fireEvent.click(screen.getByRole("button", { name: "Pause sharing" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Paused");
      fireEvent.click(screen.getByRole("button", { name: "Resume sharing" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Waiting for a player");
    });

    it("ends early only on a held press, and can be called off", () => {
      render(<DemoApp screen="inuse" />);
      const end = screen.getByRole("button", { name: "Hold to end early" });
      fireEvent.click(end);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nova-01 is in use");

      hold(end);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Player warned");
      expect(screen.getByLabelText("Your standing")).toHaveTextContent("91↓5");

      fireEvent.click(screen.getByRole("button", { name: "Cancel, let them play" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nova-01 is in use");
    });
  });
});

describe("hold to go live", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes live once the press has been held all the way", () => {
    const acts = renderReal("live", off);
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.pointerDown(reticle, { button: 0 });
    run(HOLD_MS / 2);
    expect(acts.goLive).not.toHaveBeenCalled();
    expect(reticle).toHaveAttribute("data-phase", "hold");
    run(HOLD_MS / 2 + 100);
    expect(acts.goLive).toHaveBeenCalledOnce();
  });

  it("resets with nothing started when released early", () => {
    const acts = renderReal("live", off);
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.pointerDown(reticle, { button: 0 });
    run(HOLD_MS / 2);
    fireEvent.pointerUp(window); // released anywhere, not only over the reticle
    run(HOLD_MS);
    expect(acts.goLive).not.toHaveBeenCalled();
    expect(reticle).toHaveAttribute("data-phase", "idle");
    expect(reticle.querySelector(".reticle-arc")).toHaveAttribute("stroke-dashoffset", "100.00");
  });

  it("holds from the keyboard", () => {
    const acts = renderReal("live", off);
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.keyDown(reticle, { key: " " });
    run(HOLD_MS + 100);
    fireEvent.keyUp(reticle, { key: " " });
    expect(acts.goLive).toHaveBeenCalledOnce();
  });

  it("waits for the connection details before it can be held", () => {
    renderReal("live", off, {
      connection: {
        url: "",
        machineId: "gaming-pc-1",
        machineKey: "",
        name: "",
        notice: null,
        preview: null,
      },
    });
    expect(screen.getByRole("button", { name: "Hold to go live" })).toBeDisabled();
    expect(screen.getByText(/connection details in/)).toHaveTextContent("Settings");
  });
});

describe("this PC's screens", () => {
  it("reads the PC's parts, with no rate the platform does not set", () => {
    renderReal("pc", off);
    expect(within(screen.getByRole("main")).getByText("RTX 4080")).toBeInTheDocument();
    expect(screen.getByText("Ryzen 7 7800X3D")).toBeInTheDocument();
    expect(screen.getByText("32 GB")).toBeInTheDocument();
    expect(screen.getByText("2560 × 1440, 144 Hz")).toBeInTheDocument();
    expect(screen.getByText("4 of 4")).toBeInTheDocument();
    expectNoDemoData();
  });

  it("lets the owner choose which installed games players can stream", () => {
    const acts = renderReal("games", off, {
      games: {
        installed: [
          { appid: 730, name: "Counter-Strike 2" },
          { appid: 1245620, name: "ELDEN RING" },
        ],
        offered: [730],
        demand: null,
        near: null,
      },
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Choose the games you offer");
    expect(screen.getByRole("button", { name: /Counter-Strike 2/ })).toHaveAttribute("aria-pressed", "true");
    const elden = screen.getByRole("button", { name: /ELDEN RING/ });
    expect(elden).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(elden);
    expect(acts.toggleOffer).toHaveBeenCalledWith(1245620);
    expectNoDemoData();
  });

  it("lists the installed games read-only until they are read", () => {
    renderReal("games", off);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your installed games");
    expect(screen.getByText("Counter-Strike 2")).toBeInTheDocument();
    expect(screen.getByText("ELDEN RING")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ELDEN RING/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/offered|Offering/);
    expect(screen.getByText("2 games installed")).toBeInTheDocument();
    // No game tile to install: only the field for any game the owner has, empty yet.
    expect(screen.queryByRole("link", { name: /Install on Steam/ })).not.toBeInTheDocument();
    expect(screen.getByText("Read from this PC's Steam library.")).toBeInTheDocument();
    expectNoDemoData();
  });

  it("goes live without a rate, listing the installed games", () => {
    renderReal("live", off, { now: evening(21) });
    expect(screen.queryByText("Your rate")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2 games installed See all" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/offered|Offering/);
    expect(screen.getByRole("radio", { name: /01:00/ })).toHaveAttribute("aria-checked", "true");
    expectNoDemoData();
  });

  it("waits for a player, saying only what this PC knows", () => {
    const acts = renderReal("live", {
      kind: "waiting",
      since: evening(21),
      until: evening(1),
      registered: true,
    });
    expect(screen.getByText(/gaming-pc-1 is connected to Swiff\./)).toBeInTheDocument();
    expect(screen.queryByText("Near you now")).not.toBeInTheDocument();
    expect(screen.queryByText(/You earn/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause sharing" }));
    expect(acts.pause).toHaveBeenCalledOnce();
    expectNoDemoData();
  });

  it("changes the end time while live", () => {
    const acts = renderReal("live", {
      kind: "waiting",
      since: evening(21),
      until: evening(1),
      registered: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Change end time" }));
    fireEvent.click(screen.getByRole("radio", { name: /Open/ }));
    fireEvent.click(screen.getByRole("button", { name: "Keep sharing until I stop it" }));
    expect(acts.setUntil).toHaveBeenCalledWith(null);
  });

  it("shows a player's session with only the stop of new sessions", () => {
    const acts = renderReal("live", session(false));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("ELDEN RING");
    expect(screen.getByText(/Claimed until 22:40 and protected until then\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop new sessions" }));
    expect(acts.setStopNew).toHaveBeenCalledWith(true);
    expect(screen.queryByText("this session")).not.toBeInTheDocument();
    expectNoDemoData();
  });

  it("protects the session when the owner sits down, and cannot end it early", () => {
    const acts = renderReal("live", session(true));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("gaming-pc-1 is in use");
    expect(screen.queryByRole("button", { name: /end early/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Ending a session early is not available yet\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Notify me at 22:40" }));
    expect(acts.notifyAtEnd).toHaveBeenCalledOnce();
  });

  it("reports a dropped connection with a way to retry", () => {
    const acts = renderReal("live", {
      kind: "offline",
      since: evening(21, 42),
      lastContact: evening(21, 40),
      until: null,
    });
    expect(screen.getByText("No connection to Swiff since 21:42")).toBeInTheDocument();
    expect(screen.getByText("21:40")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(acts.retry).toHaveBeenCalledOnce();
  });

  it("counts today's sessions when paused, without earnings", () => {
    renderReal("live", { kind: "paused", at: evening(21, 31) });
    expect(screen.getByText("Sharing paused at 21:31")).toBeInTheDocument();
    const tonight = screen.getByRole("heading", { name: "Tonight" }).closest("section")!;
    expect(within(tonight).getByText("1")).toBeInTheDocument();
    expectNoDemoData();
  });
});

describe("getting Steam ready", () => {
  const steam = (more: Partial<HostView["steam"]>): Partial<HostView> => ({
    steam: { status: null, installer: { kind: "idle" }, installs: [], asked: [], ...more },
  });
  const DOTA = { appid: 570, name: "Dota 2", phase: "downloading" as const, done: 25, total: 100 };

  it("offers Valve's installer when Steam is not installed", () => {
    const acts = renderReal(
      "steam",
      off,
      steam({ status: { installed: false, running: false, signedIn: false } }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Install Steam");
    expect(screen.getByText(/Valve's own installer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Get Steam/ }));
    expect(acts.installSteam).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Steam Not installed" })).toBeInTheDocument();
    expectNoDemoData();
  });

  it("says where the installer is, and why it failed", () => {
    renderReal(
      "steam",
      off,
      steam({ status: { installed: false, running: false, signedIn: false }, installer: { kind: "opened" } }),
    );
    expect(screen.getByText(/Valve's installer is open/)).toBeInTheDocument();
    cleanup();
    renderReal(
      "steam",
      off,
      steam({
        status: { installed: false, running: false, signedIn: false },
        installer: {
          kind: "failed",
          error: "The downloaded installer is not signed by Valve, so it was deleted.",
        },
      }),
    );
    expect(screen.getByText(/not signed by Valve/)).toBeInTheDocument();
  });

  it("sends the owner to Steam's own window to sign in, never asking for a password", () => {
    renderReal("steam", off, steam({ status: { installed: true, running: true, signedIn: false } }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to Steam");
    expect(screen.getByRole("link", { name: /Open Steam to sign in/ })).toHaveAttribute(
      "href",
      "steam://open/main",
    );
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: "Steam Sign in to Steam" })).toBeInTheDocument();
  });

  it("is ready once signed in, and moves on to the games", () => {
    const go = vi.fn();
    const host: Host = {
      view: realView(
        off,
        steam({ status: { installed: true, running: true, signedIn: true }, installs: [DOTA] }),
      ),
      actions: actions(),
    };
    render(<Shell host={host} step="steam" onStep={go} setupDone finishSetup={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Steam is ready");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Steam is installing 1 game.")).toBeInTheDocument();
    expect(screen.getByText(/a player who does not own it cannot play it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Choose games/ }));
    expect(go).toHaveBeenCalledWith("games");
  });

  const DEMAND = [
    { appid: 730, name: "Counter-Strike 2", looking: 4, waiting: 2 },
    { appid: 570, name: "Dota 2", looking: 3, waiting: 0 },
    { appid: 440, name: "Team Fortress 2", looking: 2, waiting: 0 },
    { appid: 1172470, name: "Apex Legends", looking: 1, waiting: 0 },
  ];

  it("ranks what renters ask for, with each install's progress and the rest to install", () => {
    const acts = renderReal("games", off, {
      ...steam({
        status: { installed: true, running: true, signedIn: true },
        installs: [DOTA],
        asked: [440],
      }),
      games: { ...realView(off).games, demand: DEMAND },
    });
    expect(screen.getByText("4 looking, 2 waiting")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Installing Dota 2" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByText("Downloading 25%")).toBeInTheDocument();
    expect(screen.getByText("Confirm in Steam")).toBeInTheDocument();
    const install = screen.getAllByRole("link", { name: /Install on Steam/ });
    expect(install.map((a) => a.getAttribute("href"))).toEqual(["steam://install/1172470"]);
    fireEvent.click(install[0]!);
    expect(acts.askInstall).toHaveBeenCalledWith(1172470);
    expect(screen.getByText(/they play with their own Steam copy/)).toBeInTheDocument();
  });

  it("lists a game Steam is installing that no renter asked for", () => {
    renderReal(
      "games",
      off,
      steam({ status: { installed: true, running: true, signedIn: true }, installs: [DOTA] }),
    );
    expect(screen.getByText("Dota 2")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Installing Dota 2" })).toBeInTheDocument();
  });

  it("installs any game the owner has, by its store link or appid", () => {
    const acts = renderReal(
      "games",
      off,
      steam({ status: { installed: true, running: true, signedIn: true } }),
    );
    const field = screen.getByLabelText("Install any game you own");
    expect(screen.queryByRole("link", { name: /Install on Steam/ })).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: "https://store.steampowered.com/app/570/Dota_2/" } });
    const link = screen.getByRole("link", { name: /Install on Steam/ });
    expect(link).toHaveAttribute("href", "steam://install/570");
    fireEvent.click(link);
    expect(acts.askInstall).toHaveBeenCalledWith(570);

    fireEvent.change(field, { target: { value: "730" } });
    expect(screen.getByText("That game is installed already.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Install on Steam/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open your Steam library/ })).toHaveAttribute(
      "href",
      "steam://open/games",
    );
  });

  it("sends the owner to install Steam before any game", () => {
    const go = vi.fn();
    const host: Host = {
      view: realView(off, {
        ...steam({ status: { installed: false, running: false, signedIn: false } }),
        games: { ...realView(off).games, demand: DEMAND },
      }),
      actions: actions(),
    };
    render(<Shell host={host} step="games" onStep={go} setupDone finishSetup={vi.fn()} />);
    expect(screen.queryByRole("link", { name: /Install on Steam/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Install any game you own")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Install Steam first" })[0]!);
    expect(go).toHaveBeenCalledWith("steam");
  });
});

describe("rental mode", () => {
  const GiB = 1024 ** 3;
  /** The fixture PC's rental read, with `change` applied to its raw facts. */
  const read = (change: (raw: typeof FACTS) => object = (raw) => raw) =>
    rentalOf(change(structuredClone(FACTS)), [{ letter: "C", games: 2 }]);
  const rental = (more: Partial<HostView["rental"]> = {}): Partial<HostView> => ({
    rental: { reading: false, read: read(), target: null, preview: null, ...more },
  });
  const installed = () =>
    read((raw) => ({
      ...raw,
      bootEntry: "{6a1f3c2e-0d4b-4e8a-9f7c-2b1d3e4f5a60}",
      partitions: [
        ...raw.partitions,
        { disk: 0, number: 6, letter: "", type: TYPE.root, offset: 0, size: 8 * GiB },
      ],
    }));

  it("offers to check again when this PC could not be read", () => {
    const acts = renderReal("rental", off, rental({ reading: false, read: null }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("This PC was not read");
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(acts.checkRental).toHaveBeenCalledOnce();
  });

  it("checks this PC first, without changing anything", () => {
    renderReal("rental", off, rental({ reading: true, read: null }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking this PC");
    expect(screen.queryByRole("button", { name: /Review the install/ })).not.toBeInTheDocument();
  });

  it("shows a ready PC's checks, and previews the install from one button", () => {
    const acts = renderReal("rental", off, rental());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ready for rental mode");
    expect(screen.getByText("8 of 10")).toBeInTheDocument();
    expect(screen.getByText("Microsoft UEFI CA 2023").closest(".krow")).toHaveTextContent("Not checked yet");
    expect(screen.getByText("TPM certificate").closest(".krow")).toHaveTextContent("Not checked yet");
    for (const step of [
      /Setup Mode/,
      /Allow Microsoft 3rd-party UEFI CA/,
      /lacks the Microsoft UEFI CA 2023/,
      /\(MOK\)/,
    ])
      expect(screen.getByText(step)).toBeInTheDocument();
    expect(screen.getByText("2.0, in the processor (AMD fTPM)")).toBeInTheDocument();
    expect(screen.getByText("24 GB from C:")).toBeInTheDocument();
    expect(screen.getByText("On: Swiff turns it off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rental mode Ready to install" })).toBeInTheDocument();
    expectNoDemoData();
    fireEvent.click(screen.getByRole("button", { name: /Review the install/ }));
    expect(acts.previewRental).toHaveBeenCalledWith("install");
  });

  it("shows the install as a preview, with its exact commands when asked", () => {
    const acts = renderReal("rental", off, rental({ preview: installPlan(read()) }));
    expect(screen.getByText("Shrink C: by 24 GB")).toBeInTheDocument();
    expect(screen.getByText("Add Swiff OS to the PC's boot menu, after Windows")).toBeInTheDocument();
    expect(screen.getByText(/nothing on this PC has been changed/)).toBeInTheDocument();
    expect(screen.queryByText(/Resize-Partition/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the commands" }));
    expect(screen.getByText(/Resize-Partition -DiskNumber 0 -PartitionNumber 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(acts.closeRentalPreview).toHaveBeenCalledOnce();
  });

  it("shows an unread IOMMU and BitLocker state as not read, never as off", () => {
    renderReal(
      "rental",
      off,
      rental({
        read: read((raw) => ({
          ...raw,
          securityProperties: [null],
          volumes: raw.volumes.map((v) => ({ ...v, bitlocker: null })),
        })),
      }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ready for rental mode");
    expect(screen.getByText("IOMMU").closest(".krow")).toHaveTextContent("Not read");
    expect(screen.getByText("C:, BitLocker not read")).toBeInTheDocument();
    expect(screen.queryByText(/Turn on the IOMMU/)).not.toBeInTheDocument();
  });

  it("lists the BIOS changes Swiff cannot make, and checks again when asked", () => {
    const acts = renderReal("rental", off, rental({ read: read((raw) => ({ ...raw, secureBoot: 0 })) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("One change in the BIOS");
    expect(screen.getByText("Turn on Secure Boot.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review the install/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(acts.checkRental).toHaveBeenCalledOnce();
  });

  it("counts only BIOS changes in the headline, and says what else blocks rental mode beside them", () => {
    const nvidia = { name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE&DEV_2704" };
    renderReal("rental", off, rental({ read: read((raw) => ({ ...raw, secureBoot: 0, gpus: [nvidia] })) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("One change in the BIOS");
    expect(screen.getByText("Turn on Secure Boot.").closest("li")).toBeInTheDocument();
    expect(
      screen.getByText("NVIDIA graphics cards come in a later Swiff OS update.").closest(".hnote"),
    ).toBeInTheDocument();
  });

  it("lets the owner choose where Swiff OS goes when there is more than one place, never its size", () => {
    const second = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
    const acts = renderReal(
      "rental",
      off,
      rental({ read: read((raw) => ({ ...raw, disks: [...raw.disks, second] })) }),
    );
    expect(screen.getByRole("radio", { name: /Disk 1/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /C:/ }));
    expect(acts.chooseRentalTarget).toHaveBeenCalledWith("shrink:C");
  });

  /** The rental screen on useRental itself, over a bridge that answers each read with `reads.next`. */
  function renderLive(reads: { next: RentalRead }) {
    (window as { swiffHost?: Partial<HostBridge> }).swiffHost = {
      readRental: vi.fn(async () => reads.next),
      planRental: vi.fn(async () => null),
      setGlance: vi.fn(),
      onTrayAction: vi.fn(() => () => {}),
    };
    function Live() {
      const { check, choose, plan, close, ...state } = useRental();
      const host: Host = {
        view: realView(off, { rental: state }),
        actions: {
          ...actions(),
          checkRental: check,
          chooseRentalTarget: choose,
          previewRental: plan,
          closeRentalPreview: close,
        },
      };
      return <Shell host={host} step="rental" onStep={vi.fn()} setupDone finishSetup={vi.fn()} />;
    }
    render(<Live />);
  }
  const second = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
  const gone = "The drive you chose is no longer available: choose again";
  afterEach(() => {
    delete (window as { swiffHost?: unknown }).swiffHost;
  });

  it("never swaps in another drive when the chosen one is gone after checking again", async () => {
    const reads = { next: read((raw) => ({ ...raw, secureBoot: 0, disks: [...raw.disks, second] })) };
    renderLive(reads);
    fireEvent.click(await screen.findByRole("radio", { name: /Disk 1/ }));
    reads.next = read();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Check again/ })));
    expect(screen.getByText(gone).closest(".krow")).toBeInTheDocument();
    expect(screen.queryByText("24 GB from C:")).not.toBeInTheDocument();
    expect(screen.queryByText(/takes 24 GB from C:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review the install/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /C:/ })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("radio", { name: /C:/ }));
    expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(screen.getByText("24 GB from C:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review the install/ })).toBeEnabled();
  });

  it("asks for no drive once Swiff OS is installed where the owner chose", async () => {
    const reads = { next: read((raw) => ({ ...raw, secureBoot: 0, disks: [...raw.disks, second] })) };
    renderLive(reads);
    fireEvent.click(await screen.findByRole("radio", { name: /Disk 1/ }));
    reads.next = installed();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Check again/ })));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Rental mode is installed");
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check again/ })).not.toBeInTheDocument();
    expect(screen.getByText("Space").closest(".krow")).toHaveTextContent("24 GB: Swiff OS is installed");
  });

  it("switches, once installed: going live and back to Windows, as previews", () => {
    const acts = renderReal("rental", off, rental({ read: installed() }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Rental mode is installed");
    fireEvent.click(screen.getByRole("button", { name: "Preview going live" }));
    expect(acts.previewRental).toHaveBeenCalledWith("start");
    fireEvent.click(screen.getByRole("button", { name: "Preview back to Windows" }));
    expect(acts.previewRental).toHaveBeenCalledWith("stop");
  });

  describe("from Go live", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...FAKE] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("still goes live once rental mode is installed: the switch is only a preview on its own screen", () => {
      const host: Host = { view: realView(off, rental({ read: installed() })), actions: actions() };
      const go = vi.fn();
      render(<Shell host={host} step="live" onStep={go} setupDone finishSetup={vi.fn()} />);
      hold(screen.getByRole("button", { name: "Hold to go live" }));
      expect(host.actions.goLive).toHaveBeenCalledOnce();
      expect(host.actions.previewRental).not.toHaveBeenCalled();
      expect(go).not.toHaveBeenCalledWith("rental");
    });
  });
});

describe("the payout form", () => {
  it("sends and keeps nothing: saving clears what was typed", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const acts = renderReal("paid", off);

    expect(
      screen.getByText(/Payouts are not open yet, so nothing you type here is sent or kept\./),
    ).toBeInTheDocument();
    const iban = screen.getByLabelText("IBAN");
    fireEvent.change(screen.getByLabelText("Account holder"), { target: { value: "Kai Example" } });
    fireEvent.change(iban, { target: { value: "DE89 3704 0044 0532 0130 00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payout details" }));

    expect(iban).toHaveValue("");
    expect(screen.getByLabelText("Account holder")).toHaveValue("");
    expect(screen.getByText("Nothing was sent or kept. The fields were cleared.")).toBeInTheDocument();
    expect(acts.savePayout).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    setItem.mockRestore();
    vi.unstubAllGlobals();
  });

  it("asks for the fields each payout method needs", () => {
    renderReal("paid", off);
    fireEvent.click(screen.getByRole("radio", { name: "PayPal" }));
    expect(screen.getByLabelText("PayPal email")).toBeInTheDocument();
    expect(screen.queryByLabelText("IBAN")).not.toBeInTheDocument();
  });
});

describe("settings", () => {
  it("saves the connection and starts sharing", async () => {
    const acts = renderReal("settings", off);
    fireEvent.change(screen.getByLabelText("Signaling server"), { target: { value: "otter.example" } });
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "gaming-pc-1");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nova-01" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save and start sharing" }));
    });
    expect(acts.saveConnection).toHaveBeenCalledWith({
      url: "otter.example",
      machineId: "gaming-pc-1",
      machineKey: "test-machine-key",
      name: "Nova-01",
    });
  });

  it("can be saved again when saving fails, and says so", async () => {
    const onStep = vi.fn();
    const host: Host = {
      view: realView(off),
      actions: { ...actions(), saveConnection: vi.fn(async () => Promise.reject(new Error("disk full"))) },
    };
    render(<Shell host={host} step="settings" onStep={onStep} setupDone finishSetup={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save and start sharing" });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(save).toBeEnabled();
    expect(onStep).not.toHaveBeenCalled();
  });

  it("cannot change under a live session", () => {
    renderReal("settings", session(false));
    expect(screen.getByLabelText("Machine key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save and start sharing" })).toBeDisabled();
    expect(screen.getByText("Pause sharing to change these.")).toBeInTheDocument();
  });
});
