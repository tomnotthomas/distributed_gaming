// The launch set import (server/scripts/import-launch-pages.mjs): an English
// page's FAQ structured data rebuilt from what it shows, and a set it refuses
// leaving its target as it was.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../../scripts/import-launch-pages.mjs", import.meta.url));

type FaqJsonLd = (html: string, lang: string) => string;
type Promote = (staging: string, target: string, rename?: (from: string, to: string) => void) => void;
const { faqJsonLd, promote } = (await import(SCRIPT)) as { faqJsonLd: FaqJsonLd; promote: Promote };

const PAGE = `<head><script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "inLanguage": "de",
  "mainEntity": [{"@type": "Question", "name": "Kostet das was?", "acceptedAnswer": {"@type": "Answer", "text": "Nein."}}]
}
</script></head><body>
<details><summary><span data-t="q1">What does {{brand}} cost?</span><span class="pm"><svg></svg></span></summary><p data-t="a1">Free&nbsp;in the <b>beta</b>, then at most &#x20AC;2 &amp; no &quot;subscription&quot;.</p></details>
<details><summary><span data-t="q2">Is 1 &lt;/script&gt; safe?</span></summary>
<p data-t="a2">Yes.</p></details>
</body>`;

describe("importing the launch set", () => {
  it("rebuilds an English page's FAQ structured data from its visible FAQ", () => {
    const html = faqJsonLd(PAGE, "en");
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    assert.deepEqual(JSON.parse(json), {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: "en",
      mainEntity: [
        {
          "@type": "Question",
          name: "What does {{brand}} cost?",
          acceptedAnswer: {
            "@type": "Answer",
            text: 'Free in the beta, then at most €2 & no "subscription".',
          },
        },
        {
          "@type": "Question",
          name: "Is 1 </script> safe?",
          acceptedAnswer: { "@type": "Answer", text: "Yes." },
        },
      ],
    });
    // A "<" in the text never closes the script early.
    assert.match(json, /Is 1 \\u003c\/script> safe\?/);
    // Only the structured data changed.
    assert.equal(html.slice(html.indexOf("</script>")), PAGE.slice(PAGE.indexOf("</script>")));
  });

  it("rebuilds only the FAQPage script, leaving another JSON-LD script before it as it was", () => {
    const org = `<script type="application/ld+json">
{"@context": "https://schema.org", "@type": "Organization", "name": "{{brand}}"}
</script>`;
    const html = faqJsonLd(`${org}\n${PAGE}`, "en");
    assert.ok(html.startsWith(org), "the Organization script is kept");
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 2);
    assert.equal(JSON.parse(scripts[0]![1]!)["@type"], "Organization");
    assert.equal(JSON.parse(scripts[1]![1]!).inLanguage, "en");
  });

  it("leaves a page without FAQ structured data, or without a visible FAQ, as it is", () => {
    assert.equal(faqJsonLd("<p>no faq</p>", "en"), "<p>no faq</p>");
    const bare = PAGE.slice(0, PAGE.indexOf("<body>"));
    assert.equal(faqJsonLd(bare, "en"), bare);
  });

  it("turns the brand, the site's origin and the app's origin into tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-set-"));
    const source = join(dir, "source");
    const target = join(dir, "marketing");
    try {
      mkdirSync(source);
      writeFileSync(
        join(source, "index.html"),
        '<title>Lanterel</title><link rel="canonical" href="https://lanterel.de/"><a href="https://swiff.onrender.com/">Prüf deine Bibliothek</a>',
      );
      await promisify(execFile)(process.execPath, [SCRIPT, source, "--target", target]);
      assert.equal(
        readFileSync(join(target, "index.html"), "utf8"),
        '<title>{{brand}}</title><link rel="canonical" href="{{site}}/"><a href="{{app}}/">Prüf deine Bibliothek</a>',
      );
      writeFileSync(join(source, "index.html"), '<a href="https://app.example/x">x</a>');
      await promisify(execFile)(process.execPath, [
        SCRIPT,
        source,
        "--target",
        target,
        "--app",
        "https://app.example",
      ]);
      assert.equal(readFileSync(join(target, "index.html"), "utf8"), '<a href="{{app}}/x">x</a>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the target as it was when it refuses a set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-set-"));
    const source = join(dir, "source");
    const target = join(dir, "marketing");
    try {
      mkdirSync(source);
      writeFileSync(join(source, "index.html"), "<title>ok</title>");
      writeFileSync(join(source, "zz.html"), "<p>{{ not ours }}</p>");
      mkdirSync(target);
      writeFileSync(join(target, "index.html"), PAGE);
      await assert.rejects(
        promisify(execFile)(process.execPath, [SCRIPT, source, "--target", target]),
        /already holds a \{\{ token/,
      );
      assert.deepEqual(readdirSync(target), ["index.html"]);
      assert.equal(readFileSync(join(target, "index.html"), "utf8"), PAGE);
      assert.equal(existsSync(`${target}.importing`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swaps a built set in for the target, keeping nothing of the old one", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-promote-"));
    try {
      const target = join(dir, "marketing");
      mkdirSync(target);
      writeFileSync(join(target, "old.html"), "old");
      mkdirSync(`${target}.importing`);
      writeFileSync(join(`${target}.importing`, "new.html"), "new");
      promote(`${target}.importing`, target);
      assert.deepEqual(readdirSync(target), ["new.html"]);
      assert.deepEqual(readdirSync(dir), ["marketing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts the old target back when the new set cannot be moved in", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-promote-"));
    try {
      const target = join(dir, "marketing");
      mkdirSync(target);
      writeFileSync(join(target, "old.html"), "old");
      mkdirSync(`${target}.importing`);
      writeFileSync(join(`${target}.importing`, "new.html"), "new");
      const failing = (from: string, to: string) => {
        if (from.endsWith(".importing")) throw new Error("EXDEV: cross-device link not permitted");
        renameSync(from, to);
      };
      assert.throws(() => promote(`${target}.importing`, target, failing), /EXDEV/);
      assert.equal(readFileSync(join(target, "old.html"), "utf8"), "old");
      assert.deepEqual(readdirSync(dir), ["marketing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puts back the old pages an interrupted import left aside, whether the next set is refused or taken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-set-"));
    const source = join(dir, "source");
    const target = join(dir, "marketing");
    const run = () => promisify(execFile)(process.execPath, [SCRIPT, source, "--target", target]);
    // Stopped between promote's renames: the old set aside, no target.
    const interrupt = () => {
      mkdirSync(`${target}.previous`);
      writeFileSync(join(`${target}.previous`, "old.html"), "old");
    };
    try {
      mkdirSync(source);
      writeFileSync(join(source, "index.html"), "<title>ok</title>");
      writeFileSync(join(source, "zz.html"), "<p>{{ not ours }}</p>");
      interrupt();
      await assert.rejects(run(), /already holds a \{\{ token/);
      assert.deepEqual(readdirSync(target), ["old.html"]);
      assert.equal(readFileSync(join(target, "old.html"), "utf8"), "old");
      assert.deepEqual(readdirSync(dir).sort(), ["marketing", "source"]);

      rmSync(target, { recursive: true });
      rmSync(join(source, "zz.html"));
      interrupt();
      await run();
      assert.deepEqual(readdirSync(target), ["index.html"]);
      assert.deepEqual(readdirSync(dir).sort(), ["marketing", "source"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
