// Rental mode's signs of life (the breathing dot, the gliding bar, a running
// mark, a rail step that is still checking) move only for owners who have not
// asked for less motion. Under prefers-reduced-motion: reduce they all stand
// still, and the numbers next to them keep updating.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Rule = { media: string[]; selector: string; style: CSSStyleDeclaration };

/** host.css as the page's stylesheet parser reads it: each style rule, with the media conditions it sits under. */
function rules(): Rule[] {
  const style = document.createElement("style");
  style.textContent = fs.readFileSync(path.join(__dirname, "host.css"), "utf8");
  document.head.append(style);
  const out: Rule[] = [];
  const walk = (list: CSSRuleList, media: string[]) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, [...media, rule.media.mediaText]);
      else if (rule instanceof CSSStyleRule)
        out.push({ media, selector: rule.selectorText, style: rule.style });
    }
  };
  walk(style.sheet!.cssRules, []);
  style.remove();
  return out;
}

const ALLOWED = "(prefers-reduced-motion: no-preference)";
const REDUCED = "(prefers-reduced-motion: reduce)";
/** The rules that run the keyframes `name`. */
const running = (all: Rule[], name: string) =>
  all.filter((r) => new RegExp(`(^|\\s)${name}(\\s|,|$)`).test(r.style.getPropertyValue("animation")));

describe("rental mode's motion", () => {
  const all = rules();

  it.each(["mpulse", "mspin", "mindet"])(
    "runs %s only when the owner has not asked for less motion",
    (name) => {
      const using = running(all, name);
      expect(using.length).toBeGreaterThan(0);
      for (const rule of using) expect(rule.media).toContain(ALLOWED);
    },
  );

  it("turns a rail step that is still checking only then too", () => {
    const checking = all.filter(
      (r) => r.selector === ".pt.checking .pd" && r.style.getPropertyValue("animation"),
    );
    expect(checking.length).toBeGreaterThan(0);
    for (const rule of checking) expect(rule.media).toContain(ALLOWED);
  });

  it("holds the bars still under reduced motion", () => {
    expect(all.some((r) => r.media.includes(REDUCED) && r.selector.includes(".mrun-bar .indet"))).toBe(true);
  });
});
