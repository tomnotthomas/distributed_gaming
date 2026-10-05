// @vitest-environment node
// Rental mode's signs of life (the breathing dot, the gliding bar, a running
// mark, a rail step that is still checking) move only for owners who have not
// asked for less motion. Under prefers-reduced-motion: reduce they all stand
// still, and the numbers next to them keep updating.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CSS = fs.readFileSync(path.join(__dirname, "host.css"), "utf8");
const ALLOWED = "@media (prefers-reduced-motion: no-preference)";

/** The stylesheet split into what is inside the no-preference blocks and what is not. */
function split(css: string): { inside: string; outside: string } {
  let inside = "";
  let outside = "";
  let at = 0;
  for (;;) {
    const start = css.indexOf(ALLOWED, at);
    if (start < 0) break;
    outside += css.slice(at, start);
    let depth = 0;
    let i = css.indexOf("{", start);
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    inside += css.slice(start, i + 1);
    at = i + 1;
  }
  return { inside, outside: outside + css.slice(at) };
}

describe("rental mode's motion", () => {
  const { inside, outside } = split(CSS);

  it.each(["mpulse", "mspin", "mindet"])(
    "runs %s only when the owner has not asked for less motion",
    (name) => {
      expect(inside).toMatch(new RegExp(`animation:\\s*${name}\\b`));
      expect(outside).not.toMatch(new RegExp(`animation:\\s*${name}\\b`));
    },
  );

  it("turns a rail step that is still checking only then too", () => {
    expect(inside).toMatch(/\.pt\.checking \.pd\s*\{\s*animation:/);
    expect(outside).not.toMatch(/\.pt\.checking \.pd\s*\{[^}]*animation:/);
  });

  it("holds the bars still under reduced motion", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.mrun-bar \.indet/);
  });
});
