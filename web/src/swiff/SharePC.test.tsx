import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEEK, type Week } from "./estimate";
import { EstimateSheet, SharePC } from "./SharePC";
import { screenAt } from "./route";
import type { Swiff } from "./useSwiff";

/**
 * Just the slice of the hook Share your PC reads, kept in real state so a
 * change made on the page or the sheet shows on both, as in the app.
 */
function Harness() {
  const [week, setWeek] = useState<Week>(DEFAULT_WEEK);
  const [estimateOpen, setEstimateOpen] = useState(false);
  const swiff = { week, setWeek, estimateOpen, setEstimateOpen } as unknown as Swiff;
  return (
    <>
      <SharePC swiff={swiff} />
      {estimateOpen ? <EstimateSheet swiff={swiff} /> : null}
    </>
  );
}

const figure = () => document.querySelector(".share-figure b")!;
const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("SharePC", () => {
  it("leads with the mockup's estimate for a High-end PC", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your PC could earn");
    expect(figure()).toHaveTextContent("€62");
    expect(radio(/High-end/)).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("30 h")).toBeInTheDocument();
    expect(screen.getByText("20:00 to 02:00")).toBeInTheDocument();
  });

  it("shows the Windows download as coming soon until an installer is published", () => {
    render(<Harness />);
    const download = screen.getByRole("button", { name: /Download for Windows/ });
    expect(download).toBeDisabled();
    expect(download).toHaveAccessibleDescription("Coming soon");
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();
    // Nothing published yet: no sum to show, and the page says where it will be.
    expect(screen.getByText(/SHA-256 is published here with it/)).toBeInTheDocument();
  });

  it("publishes the download's SHA-256 and the image set's as text, to check with Get-FileHash", () => {
    const sha = "a".repeat(64);
    const swiff = { week: DEFAULT_WEEK, setWeek: () => {}, setEstimateOpen: () => {} } as unknown as Swiff;
    render(
      <SharePC
        swiff={swiff}
        release={{
          host: {
            file: "SwiffHost-0.1.0.exe",
            sha256: sha,
            bytes: 1,
            url: "https://example.test/SwiffHost-0.1.0.exe",
          },
          image: { version: "0.1.0", files: [{ name: "swiffos.json", sha256: "b".repeat(64) }] },
        }}
      />,
    );
    const trust = within(document.getElementById("trust")!);
    expect(trust.getByText("Get-FileHash .\\SwiffHost-0.1.0.exe")).toBeInTheDocument();
    expect(trust.getByText(sha)).toBeInTheDocument();
    expect(trust.getByText("b".repeat(64))).toBeInTheDocument();
    expect(trust.getByText(/Swiff never reads, sends or keeps it/)).toBeInTheDocument();
    expect(trust.getByRole("heading", { name: "One click starts its removal" })).toBeInTheDocument();
    expect(trust.getByText(/confirm once on a blue screen during a restart/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check the download" })).toHaveAttribute("href", "#trust");
  });

  it("re-estimates when another tier is picked", () => {
    render(<Harness />);
    fireEvent.click(radio(/Enthusiast/));
    expect(radio(/Enthusiast/)).toHaveAttribute("aria-checked", "true");
    expect(radio(/High-end/)).toHaveAttribute("aria-checked", "false");
    expect(figure()).toHaveTextContent("€81");
  });

  it("moves the tier with the arrow keys and keeps one tab stop", () => {
    render(<Harness />);
    const high = radio(/High-end/);
    high.focus();
    fireEvent.keyDown(high, { key: "ArrowRight" });
    expect(radio(/Enthusiast/)).toHaveAttribute("aria-checked", "true");
    expect(radio(/Enthusiast/)).toHaveFocus();
    // Past the last tier the choice wraps round to the first.
    fireEvent.keyDown(radio(/Enthusiast/), { key: "ArrowRight" });
    expect(radio(/Entry/)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio(/Entry/), { key: "ArrowLeft" });
    expect(radio(/Enthusiast/)).toHaveFocus();

    const stops = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toEqual([radio(/Enthusiast/)]);
  });

  it("explains the number on a sheet, and puts focus back when it closes", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "How we got this number" });
    opener.focus();
    fireEvent.click(opener);

    const sheet = screen.getByRole("dialog");
    // jsdom has no layout, so it reads the sign's own span as a word: "€ 62".
    expect(sheet).toHaveAccessibleName(/^How we got € ?62$/);
    expect(within(sheet).getByRole("button", { name: "Close" })).toHaveFocus();
    expect(sheet).toHaveTextContent("30 h away a week");
    expect(sheet).toHaveTextContent("71 h streamed");
    expect(sheet).toHaveTextContent("€1,00/h for a High-end rig");
    expect(sheet).toHaveTextContent("Electricity: 71 h at 420 W, €0,30/kWh");
    expect(sheet).toHaveTextContent("Quiet to busy months: €40 to €85");

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("re-estimates the page and the sheet as the week changes", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "How we got this number" }));
    const sheet = screen.getByRole("dialog");

    fireEvent.change(within(sheet).getByLabelText("Hours away per day"), { target: { value: "8" } });
    // 8 h × 5 days = 40 h; 95 h streamed earns €95, less €12 of electricity.
    expect(sheet).toHaveTextContent("40 h away a week");
    expect(sheet).toHaveTextContent("95 h streamed");
    expect(figure()).toHaveTextContent("€83");
    expect(screen.getByText("20:00 to 04:00")).toBeInTheDocument();
    expect(screen.getByText(/8 hours a night, 5 nights a week/)).toBeInTheDocument();

    fireEvent.change(within(sheet).getByLabelText("Electricity price"), { target: { value: "0.1" } });
    expect(within(sheet).getByLabelText("Electricity price")).toHaveAttribute("aria-valuetext", "€0,10/kWh");
    expect(figure()).toHaveTextContent("€91");

    fireEvent.change(within(sheet).getByLabelText("Days per week"), { target: { value: "1" } });
    expect(screen.getByText(/8 hours a night, 1 night a week/)).toBeInTheDocument();
  });

  it("shows the example rig behind the tier's rate", () => {
    render(<Harness />);
    fireEvent.click(radio(/Entry/));
    fireEvent.click(screen.getByRole("button", { name: "How we got this number" }));
    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveTextContent("for an Entry rig");
    expect(sheet).toHaveTextContent("GPU, GTX 1660 Super");
    expect(sheet).toHaveTextContent("An example Entry rig.");
  });

  it("closes the sheet from its dim", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "How we got this number" }));
    fireEvent.click(document.querySelector(".estimate-dim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("screenAt", () => {
  it("opens Share your PC at /share and the wall everywhere else", () => {
    expect(screenAt("/share")).toBe("share");
    expect(screenAt("/share/")).toBe("share");
    expect(screenAt("/")).toBe("home");
    expect(screenAt("/games")).toBe("home");
    expect(screenAt("/shared")).toBe("home");
  });
});
