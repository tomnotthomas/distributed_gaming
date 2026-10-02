import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoApp, Shell } from "./App";
import { DEMO_SCREENS, evening, type DemoScreen } from "./demo";
import type { Claim, Host, HostActions, HostView, Live, Step } from "./model";
import { HOLD_MS } from "./ui/hold";

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
        cpu: "Ryzen 7 7800X3D",
        ramGb: 32,
        display: { width: 2560, height: 1440, refreshHz: 144 },
      },
      hardwareRate: null,
    },
    games: {
      installed: [
        { appid: 730, name: "Counter-Strike 2" },
        { appid: 1245620, name: "ELDEN RING" },
      ],
      offered: [730],
      demand: null,
      near: null,
    },
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
    games: "Choose the games you offer",
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
    expect(install.map((a) => a.getAttribute("href"))).toEqual([
      "steam://install/1086940",
      "steam://install/553850",
    ]);
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
      connection: { url: "", machineId: "gaming-pc-1", machineKey: "", notice: null, preview: null },
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

  it("offers the installed games, without demand", () => {
    const acts = renderReal("games", off);
    expect(screen.getByRole("button", { name: /Counter-Strike 2/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /ELDEN RING/ }));
    expect(acts.toggleOffer).toHaveBeenCalledWith(1245620);
    expect(screen.queryByText("Install on Steam")).not.toBeInTheDocument();
    expect(screen.getByText("Read from this PC's Steam library.")).toBeInTheDocument();
    expectNoDemoData();
  });

  it("goes live without a rate, offering the chosen games", () => {
    renderReal("live", off, { now: evening(21) });
    expect(screen.queryByText("Your rate")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Offering 1 game/ })).toBeInTheDocument();
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
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save and start sharing" }));
    });
    expect(acts.saveConnection).toHaveBeenCalledWith({
      url: "otter.example",
      machineId: "gaming-pc-1",
      machineKey: "test-machine-key",
    });
  });

  it("cannot change under a live session", () => {
    renderReal("settings", session(false));
    expect(screen.getByLabelText("Machine key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save and start sharing" })).toBeDisabled();
    expect(screen.getByText("Pause sharing to change these.")).toBeInTheDocument();
  });
});
