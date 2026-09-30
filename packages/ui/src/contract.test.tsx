// The primitive contract, checked for every export rather than trusted:
//   1. className and data-* reach the root (Dialog/Sheet: the panel).
//   2. No colour literal outside tokens/ — a new hex in component CSS is a new
//      colour the token set does not know about.
// Adding a primitive without a fixture here fails the first test on purpose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import * as primitives from "./primitives";

const noop = () => {};

const FIXTURES: Record<string, Record<string, unknown>> = {
  Avatar: { initial: "K" },
  AvatarStack: { people: [{ initial: "K" }], label: "Owners" },
  Backdrop: { image: "a.jpg" },
  Button: { children: "Go" },
  Chip: { pressed: false, onPressedChange: noop, children: "RTX" },
  Dialog: { title: "T", actions: <button>OK</button>, children: "Body" },
  Divider: {},
  EmptyState: { title: "Nothing here" },
  Field: { label: "Address", children: <input /> },
  Hero: { title: "Moss" },
  HoldButton: { onFire: noop, children: "Launch" },
  Icon: { name: "play" },
  IconButton: { icon: "close", label: "Close" },
  Input: {},
  KeyValueList: { rows: [{ term: "Rate", value: "1" }] },
  Kicker: { children: "Streaming" },
  Meter: { label: "Picture", value: 2 },
  Mosaic: { children: <div data-span="small" /> },
  Notice: { children: "Denied" },
  Overlay: { children: "…" },
  Pill: { label: "Tonight", children: "2 h" },
  ProgressRing: { pct: 0.5, label: "Starting" },
  ScrollArea: { children: "…" },
  Segment: {
    name: "q",
    "aria-label": "Quality",
    options: [{ value: "a", label: "A" }],
    value: "a",
    onChange: noop,
  },
  SettingRow: { label: "Sound", control: <input type="checkbox" /> },
  Sheet: { title: "T", closeLabel: "Close", onDismiss: noop, children: "Body" },
  SplitButton: { expanded: false, onToggle: noop, toggleLabel: "More", children: <button>Launch</button> },
  Stat: { label: "Elapsed", value: "0:42" },
  StatusDot: {},
  Stepper: { steps: ["One", "Two"], current: 0 },
  Surface: { children: "…" },
  Tag: { children: "Free" },
  TopBar: { start: "S", end: "E" },
  Trailer: { src: "clip.webm" },
};

// A component is a function or a forwardRef/memo object — not a constant like ICON_NAMES.
const isComponent = (value: unknown) =>
  typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);

const components = Object.entries(primitives).filter(([, value]) => isComponent(value)) as [
  string,
  ComponentType<Record<string, unknown>>,
][];

describe("primitive contract", () => {
  it("has a fixture for every exported primitive", () => {
    const missing = components.map(([name]) => name).filter((name) => !(name in FIXTURES));
    expect(missing).toEqual([]);
  });

  it.each(components)("%s forwards className and data-testid to its root", (name, Component) => {
    render(<Component {...FIXTURES[name]} className="from-caller" data-testid="root" />);
    expect(screen.getByTestId("root")).toHaveClass("from-caller");
  });
});

const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "tokens" ? [] : cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });

describe("token-only styling", () => {
  it.each(cssFiles(__dirname).map((path) => [relative(__dirname, path), path]))(
    "%s has no colour literals",
    (_, path) => {
      const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
    },
  );
});
