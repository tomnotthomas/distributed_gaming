import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApp, Shell } from "./App";
import { DEMO_SCREENS, evening, type DemoScreen } from "./demo";
import {
  IDLE_RUN,
  type Claim,
  type Host,
  type HostActions,
  type HostView,
  type Live,
  type Step,
} from "./model";
import { HOLD_MS } from "./ui/hold";
import { installPlan, keyRemovalPlan, rentalOf, uninstallPlan, type RentalRead } from "../rental.cjs";
import FACTS from "./test/rental-facts.json";

/** Sharing this Windows desktop: off, as in every build hosts download, unless a test turns it on. */
const share = vi.hoisted(() => ({ on: false }));
vi.mock("./devShare", () => ({
  get WINDOWS_SHARE() {
    return share.on;
  },
}));

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
    rental: { reading: false, read: null, target: null, preview: null, run: IDLE_RUN },
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
    crew: null,
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
    setCrewOnly: vi.fn(),
    runRental: vi.fn(),
    restartRental: vi.fn(),
    answerRentalKey: vi.fn(),
    goLiveRental: vi.fn(),
    retryRental: vi.fn(),
    reportRental: vi.fn(),
    seenLastLive: vi.fn(),
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
    pc: "Your PC",
    steam: "Steam is ready",
    games: "Choose the games you offer",
    "rental-checking": "Checking this PC",
    "rental-unread": "Check didn't finish",
    rental: "Turn on IOMMU",
    "rental-bios2": "Turn on Secure Boot and IOMMU",
    "rental-recheck": "Turn on IOMMU",
    "rental-bitlocker": "Turn off BitLocker on D:",
    "rental-almost": "Almost ready",
    "rental-ready": "Install rental mode",
    "rental-preview": "Write down this code",
    "rental-run-check": "Checking the Secure Boot keys",
    "rental-run-shrink": "Making room",
    "rental-run-write": "Writing Swiff OS",
    "rental-run-late": "Writing Swiff OS",
    "rental-restart": "Restart to confirm the key",
    "rental-restarting": "Restarting",
    "rental-ask": "Did the blue screen take your code?",
    "rental-key": "Confirm Swiff's key",
    "rental-key-code": "Write down this code",
    "rental-installed": "Rental mode is ready",
    "rental-back": "You were live 21:00 to 23:40",
    "rental-fail-admin": "Windows didn't give permission",
    "rental-fail-write": "Writing Swiff OS stopped",
    "rental-fail-space": "Not enough space on C:",
    "rental-timedout": "The blue screen timed out",
    "rental-nokey": "Windows started without Swiff's key",
    "rental-blocked": "Secure Boot blocked Swiff OS",
    "rental-fail-removal": "Removing rental mode stopped",
    "rental-fail-unknown": "The install stopped",
    golive: "Ready to go live",
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
    expect(screen.getByText("Elden Ring, booked until 22:40")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop new bookings" })).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
  });

  it("ranks the games by demand, with Install in Steam for the ones this PC lacks", () => {
    render(<DemoApp screen="games" />);
    expect(screen.getByText("38 looking")).toBeInTheDocument();
    const install = screen.getAllByRole("link", { name: /Install in Steam/ });
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

  it("shows the month against a ceiling at the current rate, not a forecast", () => {
    render(<DemoApp screen="paid" />);
    // €1,05 an hour, six evening hours, thirty days in September.
    expect(screen.getByText(/this month at your rate, if you're live/)).toHaveTextContent(
      "Up to €189 this month at your rate, if you're live 18:00 to midnight every day.",
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

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Paused");
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
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

      fireEvent.click(screen.getByRole("button", { name: "Let them keep playing" }));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nova-01 is in use");
    });
  });
});

describe("going live", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const GiB = 1024 ** 3;
  const installed = (key: RentalRead["key"]): Partial<HostView> => ({
    rental: {
      reading: false,
      read: {
        ...rentalOf(
          {
            ...structuredClone(FACTS),
            install: { complete: true, disk: 0, bootEntry: 1, partitions: [], shrink: null, mok: true },
          },
          [],
        ),
        key,
      },
      target: null,
      preview: null,
      run: IDLE_RUN,
    },
  });
  const ready = installed({ state: "confirmed", code: null });
  void GiB;

  it("waits for rental mode, naming its next to-do and the way back to it", () => {
    const go = vi.fn();
    const host: Host = {
      view: realView(off, {
        rental: {
          reading: false,
          read: rentalOf(structuredClone(FACTS), []),
          target: null,
          preview: null,
          run: IDLE_RUN,
        },
      }),
      actions: actions(),
    };
    render(<Shell host={host} step="live" onStep={go} setupDone finishSetup={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Finish rental mode first");
    expect(screen.getByText(/Next: install rental mode\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hold to go live" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("main button:disabled")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Open rental mode/ }));
    expect(go).toHaveBeenCalledWith("rental");
    cleanup();
    renderReal("live", off, installed({ state: "ask", code: null }));
    expect(screen.getByText(/Next: confirm Swiff's key\./)).toBeInTheDocument();
  });

  it("goes live in rental mode once the press has been held all the way", () => {
    const acts = renderReal("live", off, ready);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ready to go live");
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.pointerDown(reticle, { button: 0 });
    run(HOLD_MS / 2);
    expect(acts.goLiveRental).not.toHaveBeenCalled();
    expect(reticle).toHaveAttribute("data-phase", "hold");
    run(HOLD_MS / 2 + 100);
    expect(acts.goLiveRental).toHaveBeenCalledOnce();
    expect(acts.goLive).not.toHaveBeenCalled();
  });

  it("resets with nothing started when released early", () => {
    const acts = renderReal("live", off, ready);
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.pointerDown(reticle, { button: 0 });
    run(HOLD_MS / 2);
    fireEvent.pointerUp(window); // released anywhere, not only over the reticle
    run(HOLD_MS);
    expect(acts.goLiveRental).not.toHaveBeenCalled();
    expect(reticle).toHaveAttribute("data-phase", "idle");
    expect(reticle.querySelector(".reticle-arc")).toHaveAttribute("stroke-dashoffset", "100.00");
  });

  it("holds from the keyboard", () => {
    const acts = renderReal("live", off, ready);
    const reticle = screen.getByRole("button", { name: "Hold to go live" });
    fireEvent.keyDown(reticle, { key: " " });
    run(HOLD_MS + 100);
    fireEvent.keyUp(reticle, { key: " " });
    expect(acts.goLiveRental).toHaveBeenCalledOnce();
  });

  describe("sharing this Windows desktop, in development builds only", () => {
    beforeEach(() => {
      share.on = true;
    });
    afterEach(() => {
      share.on = false;
    });

    it("goes live once the press has been held all the way", () => {
      const acts = renderReal("live", off);
      hold(screen.getByRole("button", { name: "Hold to go live" }));
      expect(acts.goLive).toHaveBeenCalledOnce();
      expect(acts.goLiveRental).not.toHaveBeenCalled();
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

    it("goes live without a rate, listing the installed games", () => {
      renderReal("live", off, { now: evening(21) });
      expect(screen.queryByText("Your rate")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "2 games installed See all" })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/offered|Offering/);
      expect(screen.getByRole("radio", { name: /01:00/ })).toHaveAttribute("aria-checked", "true");
      expectNoDemoData();
    });

    it("builds the rate in the open", () => {
      render(<DemoApp screen="golive" />);
      const rate = screen.getByRole("heading", { name: "Your rate" }).closest("section")!;
      expect(rate).toHaveTextContent("Hardware, RTX 4080€1,00");
      expect(rate).toHaveTextContent("Reliability 96100%");
      expect(rate).toHaveTextContent("Level Steady+5%");
      expect(rate).toHaveTextContent("Up to €4,20 tonight if players stay until 01:00.");
    });
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

  it("shows the PC and Steam reads as checking while they run, never as undone", () => {
    renderReal("pc", off, { pc: { reading: true, hardware: null, hardwareRate: null } });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Reading your PC");
    expect(screen.getByText("Checking now")).toBeInTheDocument();
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
    // Steam can be set up while the read runs: nothing waits behind a greyed button.
    expect(screen.getByRole("button", { name: /Set up Steam/ })).toBeEnabled();
    cleanup();

    renderReal("steam", off, {
      steam: { status: null, installer: { kind: "idle" }, installs: [], asked: [] },
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Checking Steam");
    expect(screen.getByText("Checking now")).toBeInTheDocument();
    expect(screen.queryByText("No")).not.toBeInTheDocument();
    cleanup();

    renderReal("games", off, {
      pc: { reading: true, hardware: null, hardwareRate: null },
      games: { installed: [], offered: null, demand: null, near: null },
    });
    expect(screen.getByText("Checking for installed Steam games.")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: /Install in Steam/ })).not.toBeInTheDocument();
    expect(screen.getByText("From your Steam library on this PC.")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(acts.pause).toHaveBeenCalledOnce();
    expectNoDemoData();
  });

  it("asks who can play only once the platform says this PC's owner is in a crew", () => {
    renderReal("live", { kind: "waiting", since: evening(21), until: evening(1), registered: true });
    expect(screen.queryByRole("radiogroup", { name: "Who can play" })).not.toBeInTheDocument();
    cleanup();

    const acts = renderReal(
      "live",
      { kind: "waiting", since: evening(21), until: evening(1), registered: true },
      { crew: { only: true, crews: [{ name: "mika_r", own: false, size: 3 }] } },
    );
    const group = screen.getByRole("radiogroup", { name: "Who can play" });
    expect(within(group).getByRole("radio", { name: /Crew only/ })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: /Crew only/ })).toHaveTextContent("2 players you know");
    expect(screen.getByText("Only mika_r's crew can claim this PC.")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("radio", { name: /Anyone/ }));
    expect(acts.setCrewOnly).toHaveBeenCalledWith(false);
  });

  it("keeps asking on a crew-only PC nobody else may play on, with the ways out", () => {
    const acts = renderReal(
      "live",
      { kind: "waiting", since: evening(21), until: evening(1), registered: true },
      { crew: { only: true, crews: [] } },
    );
    const group = screen.getByRole("radiogroup", { name: "Who can play" });
    expect(within(group).getByRole("radio", { name: /Crew only/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Nobody in your crew can play on this PC right now\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open to everyone" }));
    expect(acts.setCrewOnly).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/in your browser/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Invite a friend" }));
    expect(screen.getByText("https://signal.example")).toBeInTheDocument();
    expect(screen.getByText(/send your link from Ask your PC friend on your profile/)).toBeInTheDocument();
    cleanup();

    renderReal("live", off, { now: evening(21), crew: { only: true, crews: [] } });
    expect(screen.getByRole("radiogroup", { name: "Who can play" })).toBeInTheDocument();
    expect(screen.getByText(/Nobody in your crew can play on this PC right now\./)).toBeInTheDocument();
    cleanup();

    renderReal("live", off, { now: evening(21), crew: { only: false, crews: [] } });
    expect(screen.queryByRole("radiogroup", { name: "Who can play" })).not.toBeInTheDocument();
  });

  it("says anyone may claim a PC its owner opened, and names a crew Steam gave no name for", () => {
    renderReal("live", off, {
      now: evening(21),
      crew: { only: false, crews: [{ name: null, own: false, size: 2 }] },
    });
    expect(screen.getByRole("radio", { name: /Anyone/ })).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText("Anyone on Swiff can claim this PC, your friend's crew too."),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Stay live until I stop" }));
    expect(acts.setUntil).toHaveBeenCalledWith(null);
  });

  it("shows a player's session with only the stop of new sessions", () => {
    const acts = renderReal("live", session(false));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("ELDEN RING");
    expect(screen.getByText(/Booked until 22:40\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop new bookings" }));
    expect(acts.setStopNew).toHaveBeenCalledWith(true);
    expect(screen.queryByText("this session")).not.toBeInTheDocument();
    expectNoDemoData();
  });

  it("protects the session when the owner sits down, and cannot end it early", () => {
    const acts = renderReal("live", session(true));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("gaming-pc-1 is in use");
    expect(screen.queryByRole("button", { name: /end early/i })).not.toBeInTheDocument();
    expect(screen.getByText(/You can't end it early yet\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Notify me at 22:40" }));
    expect(acts.notifyAtEnd).toHaveBeenCalledOnce();
    cleanup();
    // Once asked, it says so plainly: no disabled button stands in for it.
    renderReal("live", { ...session(true), notify: true } as Live);
    expect(screen.getByRole("status")).toHaveTextContent("We'll tell you at 22:40.");
    expect(within(screen.getByRole("main")).queryByRole("button", { name: /22:40/ })).not.toBeInTheDocument();
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
    expect(screen.getByText("Paused at 21:31", { selector: ".banner" })).toBeInTheDocument();
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
    expect(screen.getByText(/Swiff downloads the Steam installer for you/)).toBeInTheDocument();
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
    expect(screen.getByText(/The Steam installer is open/)).toBeInTheDocument();
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
    expect(screen.getByText(/Players need to own a game on Steam to play it here/)).toBeInTheDocument();
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
    expect(screen.getByText("Click Install in Steam")).toBeInTheDocument();
    const install = screen.getAllByRole("link", { name: /Install in Steam/ });
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
    expect(screen.queryByRole("link", { name: /Install in Steam/ })).not.toBeInTheDocument();
    // Nothing to install yet is no button at all, not a greyed one.
    expect(screen.queryByText("Install in Steam")).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: "https://store.steampowered.com/app/570/Dota_2/" } });
    const link = screen.getByRole("link", { name: /Install in Steam/ });
    expect(link).toHaveAttribute("href", "steam://install/570");
    fireEvent.click(link);
    expect(acts.askInstall).toHaveBeenCalledWith(570);

    fireEvent.change(field, { target: { value: "730" } });
    expect(screen.getByText("That game is installed already.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Install in Steam/ })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("link", { name: /Install in Steam/ })).not.toBeInTheDocument();
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
    rental: { reading: false, read: read(), target: null, preview: null, run: IDLE_RUN, ...more },
  });
  /** What a finished install recorded on the fixture PC. */
  const RECORD = {
    complete: true,
    disk: 0,
    bitlocker: null,
    fastStartup: true,
    shrink: { letter: "C", partition: 3, from: 1000 * GiB, to: 976 * GiB },
    partitions: [{ role: "esp", id: "00000000-0000-4000-8000-000000000000", offset: 976 * GiB, bytes: GiB }],
    bootEntry: 1,
    windowsEntry: 0,
    labels: [],
    mok: true,
  };
  const installed = (key: RentalRead["key"] = { state: "confirmed", code: null }): RentalRead => ({
    ...read((raw) => ({ ...raw, install: RECORD })),
    key,
  });
  const nvidia = { name: "NVIDIA GeForce RTX 4080", pnp: "PCI\\VEN_10DE&DEV_2704" };
  const h1 = () => screen.getByRole("heading", { level: 1 });
  /** The screen's pill buttons: each state has at most one. */
  const pills = () => document.querySelectorAll("main .lpill");
  /** The rail's current rental sub-step. */
  const subStep = () => document.querySelector(".psub [aria-current='step']")?.textContent;

  it("checks this PC first, with nothing to press", () => {
    renderReal("rental", off, rental({ reading: true, read: null }));
    expect(h1()).toHaveTextContent("Checking this PC");
    expect(screen.getByText("This takes a few seconds.")).toBeInTheDocument();
    expect(pills()).toHaveLength(0);
    expect(subStep()).toBe("Get the PC ready");
  });

  it("offers to check again when the check did not finish", () => {
    const acts = renderReal("rental", off, rental({ read: null }));
    expect(h1()).toHaveTextContent("Check didn't finish");
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(acts.checkRental).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Rental mode Check didn't finish" })).toBeInTheDocument();
  });

  it("names the BIOS setting to change, shows what to set it to on the plate, and the trip as a strip", () => {
    const acts = renderReal(
      "rental",
      off,
      rental({ read: read((raw) => ({ ...raw, securityProperties: [1, 2] })) }),
    );
    expect(h1()).toHaveTextContent("Turn on IOMMU");
    const plate = document.querySelector(".plate")!;
    expect(plate).toHaveTextContent("Set to");
    expect(plate).toHaveTextContent("IOMMUEnabled");
    expect(plate.textContent).not.toMatch(/\d+ of \d+/);
    const strip = screen.getByRole("region", { name: "In the BIOS" });
    expect(
      within(strip)
        .getAllByRole("listitem")
        .map((li) => li.querySelector(":scope > b")!.textContent),
    ).toEqual(["Open the BIOS", "Turn on IOMMU", "Save and exit", "Check again"]);
    expect(pills()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(acts.checkRental).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Rental mode 1 BIOS setting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Secure Boot won't turn on?" })).toBeInTheDocument();
  });

  it("keeps the passing checks behind What Swiff checked, the ones the install checks included", () => {
    renderReal("rental", off, rental({ read: read((raw) => ({ ...raw, securityProperties: [1, 2] })) }));
    expect(screen.queryByText("Microsoft UEFI CA 2011")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What Swiff checked" }));
    expect(screen.getByText("Microsoft UEFI CA 2011").closest(".krow")).toHaveTextContent(
      "Checked when you install",
    );
    expect(screen.getByText("TPM certificate").closest(".krow")).toHaveTextContent(
      "Checked when you install",
    );
    expect(screen.getByText("Fast Startup").closest(".krow")).toHaveTextContent(
      "On. The install turns it off",
    );
    expect(screen.getByText("IOMMU", { selector: ".krow span" }).closest(".krow")).toHaveTextContent("Off");
  });

  it("puts BitLocker first, in Windows, and names the BIOS trip after it", () => {
    renderReal(
      "rental",
      off,
      rental({
        read: read((raw) => ({
          ...raw,
          securityProperties: [1, 2],
          volumes: raw.volumes.map((v) => ({ ...v, bitlocker: 1 })),
        })),
      }),
    );
    expect(h1()).toHaveTextContent("Turn off BitLocker on C:");
    expect(screen.getByText("After this: turn on IOMMU in the BIOS.")).toBeInTheDocument();
    expect(document.querySelector(".plate")).toHaveTextContent("C: BitLockerOff");
    expect(screen.getByRole("region", { name: "In Windows" })).toHaveTextContent("Open BitLocker");
  });

  it("asks nothing of an NVIDIA PC with everything else ready: it waits for the update", () => {
    renderReal("rental", off, rental({ read: read((raw) => ({ ...raw, gpus: [nvidia] })) }));
    expect(h1()).toHaveTextContent("Almost ready");
    expect(pills()).toHaveLength(0);
    expect(document.querySelector(".plate")).toHaveTextContent("Waiting for");
    expect(document.querySelector(".plate")).toHaveTextContent("Graphics card supportSwiff OS update");
    expect(screen.getByRole("button", { name: "Rental mode Not on NVIDIA yet" })).toBeInTheDocument();
  });

  it("shows the graphics card only as waiting beside the IOMMU on an NVIDIA PC", () => {
    renderReal(
      "rental",
      off,
      rental({ read: read((raw) => ({ ...raw, gpus: [nvidia], securityProperties: [1, 2] })) }),
    );
    expect(h1()).toHaveTextContent("Turn on IOMMU");
    expect(document.querySelector(".mtrow.wait")).toHaveTextContent("Graphics cardUpdate coming");
  });

  it("shows the re-check on the same button for the few seconds it runs", () => {
    renderReal(
      "rental",
      off,
      rental({ reading: true, read: read((raw) => ({ ...raw, securityProperties: [1, 2] })) }),
    );
    expect(screen.getByRole("button", { name: /Checking/ })).toBeDisabled();
    expect(screen.getByLabelText("Checking")).toBeInTheDocument();
  });

  it("offers the install from one button, and another drive as a quiet link", () => {
    const second = { number: 1, style: "GPT", size: 500 * GiB, sector: 512, bus: "SATA", system: false };
    const acts = renderReal(
      "rental",
      off,
      rental({ read: read((raw) => ({ ...raw, disks: [...raw.disks, second] })) }),
    );
    expect(h1()).toHaveTextContent("Install rental mode");
    expect(screen.getByText(/Swiff OS goes on 24 GB of free space on disk 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use C: instead" }));
    expect(acts.chooseRentalTarget).toHaveBeenCalledWith("shrink:C");
    fireEvent.click(screen.getByRole("button", { name: /See the install/ }));
    expect(acts.previewRental).toHaveBeenCalledWith("install");
    expect(subStep()).toBe("Install Swiff OS");
    expectNoDemoData();
  });

  it("puts the code on the plate before the install, with the blue screen as a strip and one OK", () => {
    const acts = renderReal("rental", off, rental({ preview: installPlan(read(), { code: "48217730" }) }));
    expect(h1()).toHaveTextContent("Write down this code");
    expect(document.querySelector(".plate .mplatecode")).toHaveTextContent("4821 7730");
    const strip = screen.getByRole("region", { name: "After the restart, on the blue screen" });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(6);
    expect(strip).toHaveTextContent("Choose Reboot");
    expect(pills()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Install/ }));
    expect(acts.runRental).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "What the install does, 9 steps" }));
    expect(screen.getByText("Copy Swiff OS onto them")).toBeInTheDocument();
  });

  it("tells the owner to look for Windows' prompt while it is up", () => {
    renderReal(
      "rental",
      off,
      rental({ preview: installPlan(read()), run: { ...IDLE_RUN, status: "starting" } }),
    );
    expect(h1()).toHaveTextContent("Waiting for Windows");
    expect(document.querySelector(".mstatus")).toHaveTextContent(
      "No prompt? Look for a flashing shield on the taskbar and click it.",
    );
    expect(pills()).toHaveLength(0);
  });

  it("shows the write's bytes, how long is left, and a sign of life, with nothing to press", () => {
    const plan = installPlan(read());
    const steps = Object.fromEntries(plan.steps.slice(0, 4).map((s) => [s.id, "done" as const]));
    const now = Date.now();
    const total = 9.8e9;
    renderReal(
      "rental",
      off,
      rental({
        preview: plan,
        run: {
          ...IDLE_RUN,
          status: "running",
          steps: { ...steps, write: "running" },
          stepStartedAt: now - 131_000,
          progress: { id: "write", done: 4.1e9, total },
          meter: {
            since: now - 131_000,
            at: now,
            done: 4.1e9,
            rate: 30e6,
            mark: { at: now - 1000, done: 4.07e9 },
            recent: 30e6,
          },
        },
      }),
    );
    expect(h1()).toHaveTextContent("Writing Swiff OS");
    expect(screen.getByText(/About 3 minutes left\. Keep the PC on\./)).toBeInTheDocument();
    expect(screen.getByText(/Step 5 of 9, running for 2:1\d/)).toBeInTheDocument();
    expect(document.querySelector(".plate")).toHaveTextContent("4.1 GB");
    expect(document.querySelector(".plate")).toHaveTextContent("of 9.8 GB written");
    expect(screen.getByRole("button", { name: "Rental mode Installing, 41%" })).toBeInTheDocument();
    expect(pills()).toHaveLength(0);
    expect(document.querySelector(".mrun li.now")).toHaveTextContent("4.1 of 9.8 GB");
  });

  it("stops at the restart: the code on the plate, the 10 seconds said large, and Restart now", () => {
    const plan = installPlan(read(), { code: "48217730" });
    const acts = renderReal("rental", off, rental({ preview: plan, run: { ...IDLE_RUN, status: "done" } }));
    expect(h1()).toHaveTextContent("Restart to confirm the key");
    expect(document.querySelector(".mwarn")).toHaveTextContent(
      "Press a key the moment you see Press any key to perform MOK management. It waits only 10 seconds.",
    );
    expect(document.querySelector(".plate .mplatecode")).toHaveTextContent("4821 7730");
    expect(screen.getByText(/Don't choose Continue boot/)).toBeInTheDocument();
    expect(pills()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Restart now/ }));
    expect(acts.restartRental).toHaveBeenCalledOnce();
  });

  it("asks the owner whether the blue screen took the code, which Windows cannot see", () => {
    const acts = renderReal("rental", off, rental({ read: installed({ state: "ask", code: null }) }));
    expect(h1()).toHaveTextContent("Did the blue screen take your code?");
    expect(subStep()).toBe("Confirm the key");
    fireEvent.click(screen.getByRole("button", { name: /Yes, it did/ }));
    expect(acts.answerRentalKey).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "No, or I'm not sure" }));
    expect(acts.answerRentalKey).toHaveBeenCalledWith(false);
  });

  it("confirms the key again with a new code, with the blue screen on the plate", () => {
    const acts = renderReal("rental", off, rental({ read: installed({ state: "missed", code: null }) }));
    expect(h1()).toHaveTextContent("Confirm Swiff's key");
    expect(document.querySelector(".plate")).toHaveTextContent("Press any key to perform MOK management");
    expect(screen.getByRole("region", { name: "After the restart, on the blue screen" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: /Confirm the key/ }));
    expect(acts.previewRental).toHaveBeenCalledWith("mok");
    expect(screen.getByRole("button", { name: "Rental mode Confirm the key" })).toBeInTheDocument();
  });

  it("is ready once the key is confirmed: Go live, with removal one quiet link away", () => {
    const go = vi.fn();
    const host: Host = { view: realView(off, rental({ read: installed() })), actions: actions() };
    render(<Shell host={host} step="rental" onStep={go} setupDone finishSetup={vi.fn()} />);
    expect(h1()).toHaveTextContent("Rental mode is ready");
    expect(screen.getByText("Rental mode, installed")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: /^Go live/ }));
    expect(go).toHaveBeenCalledWith("live");
    fireEvent.click(screen.getByRole("button", { name: "Remove rental mode" }));
    expect(host.actions.previewRental).toHaveBeenCalledWith("uninstall");
    expect(document.querySelectorAll(".psub .done")).toHaveLength(3);
  });

  it("offers to continue an install that stopped part way, and to undo it", () => {
    const acts = renderReal(
      "rental",
      off,
      rental({ read: read((raw) => ({ ...raw, install: { ...RECORD, complete: false } })) }),
    );
    expect(h1()).toHaveTextContent("The install didn't finish");
    fireEvent.click(screen.getByRole("button", { name: /Continue the install/ }));
    expect(acts.previewRental).toHaveBeenCalledWith("install");
    fireEvent.click(screen.getByRole("button", { name: "Undo what was done" }));
    expect(acts.previewRental).toHaveBeenCalledWith("uninstall");
  });

  it("lists the removal's steps before its one OK", () => {
    const acts = renderReal(
      "rental",
      off,
      rental({ read: installed(), preview: uninstallPlan(installed()) }),
    );
    expect(h1()).toHaveTextContent("Remove rental mode");
    expect(screen.getByText("Take Swiff OS out of the boot menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Remove rental mode/ }));
    expect(acts.runRental).toHaveBeenCalledOnce();
  });

  it("guides the key's removal with its own code and Delete MOK", () => {
    renderReal("rental", off, rental({ read: installed(), preview: keyRemovalPlan("55554444") }));
    expect(document.querySelector(".plate .mplatecode")).toHaveTextContent("5555 4444");
    expect(screen.getByText("Choose Delete MOK")).toBeInTheDocument();
  });

  describe("when a step stops", () => {
    const plan = installPlan(read(), { code: "48217730" });
    const failedAt = (step: string, error: string, more: Partial<HostView["rental"]["run"]> = {}) =>
      rental({
        preview: plan,
        run: { ...IDLE_RUN, status: "failed", failed: { step, error }, endedAt: evening(21, 4), ...more },
      });

    it("asks Windows again after a declined prompt, and shows how to find it", () => {
      const acts = renderReal(
        "rental",
        off,
        failedAt("elevate", "Windows did not give Swiff Host administrator rights."),
      );
      expect(h1()).toHaveTextContent("Windows didn't give permission");
      expect(screen.getByText("Nothing on this PC has changed.")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "When Windows asks" })).toHaveTextContent("No prompt?");
      fireEvent.click(screen.getByRole("button", { name: /Ask again/ }));
      expect(acts.retryRental).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Rental mode Needs permission" })).toBeInTheDocument();
    });

    it("says how far the write got and what changed, and keeps the exact error one link away", () => {
      const error = "Write to disk 0, partition 5 failed at 4,402,341,888 bytes. (0x8007045D)";
      const steps = Object.fromEntries(plan.steps.slice(0, 4).map((s) => [s.id, "done" as const]));
      const acts = renderReal(
        "rental",
        off,
        failedAt("write", error, {
          steps: { ...steps, write: "failed" },
          progress: { id: "write", done: 4.1e9, total: 9.8e9 },
        }),
      );
      expect(h1()).toHaveTextContent("Writing Swiff OS stopped");
      expect(screen.getByText("The drive reported an error after 4.1 of 9.8 GB.")).toBeInTheDocument();
      expect(document.querySelector(".mchanged")).toHaveTextContent("C: is already 24 GB smaller.");
      expect(document.querySelector(".plate")).toHaveTextContent("at 4.1 of 9.8 GB");
      expect(document.querySelector(".plate")).toHaveTextContent("Stopped at 21:04");
      expect(screen.queryByText(error)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "What happened, in detail" }));
      expect(screen.getByText(error)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Send details to Swiff" }));
      expect(acts.reportRental).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
      expect(acts.retryRental).toHaveBeenCalledOnce();
      expect(subStep()).toBe("Install Swiff OS");
    });

    it("sends an unknown error's details as its one action, then says what was sent", () => {
      const acts = renderReal("rental", off, failedAt("fast-startup", "reg failed: exit code 1"));
      expect(h1()).toHaveTextContent("The install stopped");
      expect(
        screen.getByText(/while turning off Fast Startup, and Swiff doesn't know this error yet/),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Send details to Swiff/ }));
      expect(acts.reportRental).toHaveBeenCalledOnce();
      cleanup();
      renderReal(
        "rental",
        off,
        failedAt("fast-startup", "reg failed: exit code 1", { reportedAt: evening(21, 6) }),
      );
      expect(
        screen.getByText(/Sent at 21:06\. Swiff got the error, the step and this PC's checks\./),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
    });

    it("puts the space failure on step 1, with the drives' free space on the plate", () => {
      renderReal("rental", off, failedAt("room", "C: cannot shrink by 24 GB."));
      expect(h1()).toHaveTextContent("Not enough space on C:");
      expect(document.querySelector(".plate")).toHaveTextContent("Free now, Swiff OS needs 24 GB");
      expect(subStep()).toBe("Get the PC ready");
    });
  });

  it.each([
    ["timedout", "The blue screen timed out", /Restart and try again/],
    ["nokey", "Windows started without Swiff's key", /Confirm the key/],
    ["blocked", "Secure Boot blocked Swiff OS", /Check again/],
  ] as const)("says what the boot log showed after the restart: %s", (state, title, action) => {
    renderReal("rental", off, rental({ read: installed({ state, code: null }) }));
    expect(h1()).toHaveTextContent(title);
    expect(pills()).toHaveLength(1);
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    expect(subStep()).toBe("Confirm the key");
  });

  it("sums up the last live run back in Windows, once", () => {
    const go = vi.fn();
    const lastLive = { from: evening(21), to: evening(23, 40), sessions: 2, early: 0, earned: null };
    const host: Host = {
      view: realView(off, rental({ read: { ...installed(), lastLive } })),
      actions: actions(),
    };
    render(<Shell host={host} step="rental" onStep={go} setupDone finishSetup={vi.fn()} />);
    expect(h1()).toHaveTextContent("You were live 21:00 to 23:40");
    expect(screen.getByText(/2 sessions, both ran to their end/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Go live again/ }));
    expect(host.actions.seenLastLive).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledWith("live");
  });
});

describe("the rail", () => {
  it("hangs rental mode's three steps under it only while it is the current step", () => {
    renderReal("rental", off);
    expect([...document.querySelectorAll(".psub li")].map((li) => li.textContent)).toEqual([
      "Get the PC ready",
      "Install Swiff OS",
      "Confirm the key",
    ]);
    cleanup();
    renderReal("pc", off);
    expect(document.querySelector(".psub")).toBeNull();
  });

  it("marks rental mode done only once it is ready", () => {
    renderReal("pc", off);
    expect(screen.getByRole("button", { name: /^Rental mode/ }).closest("li")).not.toHaveClass("done");
  });

  it("shows This PC, Steam and Games as checking while their reads run, never as undone", () => {
    // From the start: the steps not passed yet turn while their reads run.
    const base = realView(off);
    const view = realView(off, {
      pc: { ...base.pc, reading: true, hardware: null },
      steam: { ...base.steam, status: null },
    });
    render(
      <Shell
        host={{ view, actions: actions() }}
        step="pc"
        onStep={vi.fn()}
        setupDone={false}
        finishSetup={vi.fn()}
      />,
    );
    for (const name of [/^This PC/, /^Steam/, /^Games/])
      expect(screen.getByRole("button", { name }).closest("li")).toHaveClass("checking");
    expect(screen.getByRole("button", { name: /^Steam Checking Steam/ })).toBeInTheDocument();
    cleanup();
    renderReal("rental", off);
    expect(document.querySelectorAll(".pt.checking")).toHaveLength(0);
  });
});

describe("every rental state in the demo", () => {
  const cases = DEMO_SCREENS.filter((s) => s.id.startsWith("rental"));

  it.each(cases)("$name has at most one pill, and nothing disabled but a re-check", ({ id }) => {
    render(<DemoApp screen={id} />);
    const main = screen.getByRole("main");
    expect(main.querySelectorAll(".lpill").length).toBeLessThanOrEqual(1);
    for (const button of main.querySelectorAll("button:disabled"))
      expect(button).toHaveTextContent("Checking");
    // Never a count of checks ("6 of 8"): bytes written and a stopped step's place are not counts of checks.
    expect(main.querySelector(".plate")?.textContent ?? "").not.toMatch(
      /(?<!step )(?<![.\d])\d+ of \d+(?![.\d]| GB)/i,
    );
  });

  it.each(cases.filter((s) => /fail|timedout|nokey|blocked/.test(s.id)))(
    "$name says what happened with exactly one action",
    ({ id }) => {
      render(<DemoApp screen={id} />);
      expect(screen.getByRole("main").querySelectorAll(".lpill")).toHaveLength(1);
    },
  );
});

describe("the payout form", () => {
  it("sends and keeps nothing: saving clears what was typed", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const acts = renderReal("paid", off);

    expect(
      screen.getByText(/Payouts aren't open yet\. Nothing you type here is sent or saved\./),
    ).toBeInTheDocument();
    const iban = screen.getByLabelText("IBAN");
    fireEvent.change(screen.getByLabelText("Account holder"), { target: { value: "Kai Example" } });
    fireEvent.change(iban, { target: { value: "DE89 3704 0044 0532 0130 00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payout details" }));

    expect(iban).toHaveValue("");
    expect(screen.getByLabelText("Account holder")).toHaveValue("");
    expect(screen.getByText("Cleared. Nothing was sent.")).toBeInTheDocument();
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
  it("saves the connection, with nothing in it that shares this Windows desktop", async () => {
    const onStep = vi.fn();
    const host: Host = { view: realView(off), actions: actions() };
    render(<Shell host={host} step="settings" onStep={onStep} setupDone finishSetup={vi.fn()} />);
    // The signaling server, the screen preview and going live from here are the development path only.
    expect(screen.queryByLabelText("Signaling server")).not.toBeInTheDocument();
    expect(screen.queryByText(/Capturing|Not capturing/)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).queryByRole("button", { name: /go live|sharing/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "gaming-pc-1");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nova-01" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(host.actions.saveConnection).toHaveBeenCalledWith({
      url: "signal.example",
      machineId: "gaming-pc-1",
      machineKey: "test-machine-key",
      name: "Nova-01",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(onStep).not.toHaveBeenCalled();
  });

  it("can be saved again when saving fails, and says so", async () => {
    const onStep = vi.fn();
    const host: Host = {
      view: realView(off),
      actions: { ...actions(), saveConnection: vi.fn(async () => Promise.reject(new Error("disk full"))) },
    };
    render(<Shell host={host} step="settings" onStep={onStep} setupDone finishSetup={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save" });
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
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Pause to change these.")).toBeInTheDocument();
  });
});
