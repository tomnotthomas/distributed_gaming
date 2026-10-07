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
const { faqJsonLd, promote, signInPath, wireSignIn, neutralWording, withoutReminders } = (await import(
  SCRIPT
)) as {
  faqJsonLd: FaqJsonLd;
  promote: Promote;
  signInPath: (to: string) => string;
  wireSignIn: (html: string) => string;
  neutralWording: (text: string) => string;
  withoutReminders: (html: string) => string;
};

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

  it("sends every sign-in button to Steam on the app's origin, landing on its crew pages", () => {
    assert.equal(signInPath("/share/"), "/crews?found=1");
    assert.equal(signInPath("/en/share/?pc=1"), "/crews?found=1&pc=1");
    assert.equal(signInPath("/share/?joined=1&state=ready"), "/crews");
    const html = wireSignIn(
      '<a href="/auth/steam/login?to=/share/%3Fpc%3D1" data-signin>a</a>' +
        '<a href="/auth/steam/login?to=/en/share/">b</a><a href="/auth/steam/login?to=%E0%A4%A">c</a>' +
        '<a href="/elsewhere/">d</a>',
    );
    assert.equal(
      html,
      '<a href="{{app}}/auth/steam/login?to=%2Fcrews%3Ffound%3D1%26pc%3D1" data-signin>a</a>' +
        '<a href="{{app}}/auth/steam/login?to=%2Fcrews%3Ffound%3D1">b</a>' +
        '<a href="{{app}}/auth/steam/login?to=%2Fcrews%3Ffound%3D1">c</a><a href="/elsewhere/">d</a>',
    );
  });

  it("leaves the privacy pages' section on reminders by email out, and every other section in", () => {
    assert.equal(
      withoutReminders(
        "<h2>Steam</h2><p>a</p><h2>Wenn du dich erinnern lässt</h2><p>b</p><p>c</p>\n<h2>Einladungen</h2><p>d</p>",
      ),
      "<h2>Steam</h2><p>a</p><h2>Einladungen</h2><p>d</p>",
    );
    assert.equal(
      withoutReminders("<h2>When you ask for reminders</h2><p>b</p><h2>Invites</h2>"),
      "<h2>Invites</h2>",
    );
    // The last section on its page goes too, up to where the page's text ends.
    assert.equal(
      withoutReminders("<main><h2>Steam</h2><p>a</p><h2>When you ask for reminders</h2><p>b</p></main>"),
      "<main><h2>Steam</h2><p>a</p></main>",
    );
    assert.equal(
      withoutReminders("<h2>Steam</h2><h2>Wenn du dich erinnern lässt</h2><p>b</p>"),
      "<h2>Steam</h2>",
    );
  });

  it("says Zockrunde and gaming session, never an evening or a night, and leaves keys and routes alone", () => {
    assert.equal(neutralWording("So läuft ein Crew-Abend"), "So läuft eine Zockrunde");
    assert.equal(neutralWording("Max lädt dich zum Crew-Abend ein"), "Max lädt dich zur Zockrunde ein");
    // "Zockrunde" is feminine: its articles follow it.
    assert.equal(
      neutralWording("dann erinnern wir dich vor jedem Crew-Abend."),
      "dann erinnern wir dich vor jeder Zockrunde.",
    );
    // A slip in marketing's build is corrected too.
    assert.equal(neutralWording("(§ 25(2) TDDDG). /</p>"), "(§ 25(2) TDDDG).</p>");
    assert.equal(
      neutralWording(
        "Sie spielen ihre eigenen Spiele. Ob später auch Mac-Spieler von unserer Warteliste dazukommen, entscheidest du.</p>",
      ),
      "Sie spielen ihre eigenen Spiele.</p>",
    );
    assert.equal(
      neutralWording(
        "They play their own games. Whether Mac players from our waitlist join later is up to you.</p>",
      ),
      "They play their own games.</p>",
    );
    assert.equal(neutralWording("Frei: meist abends ab 20 Uhr"), "Frei: wenn der PC frei ist");
    assert.equal(
      neutralWording("Eine Crew für unsere Zockabende, zwei Testabende, Testabend 1"),
      "Eine Crew für unsere Zockrunden, zwei Testrunden, Testrunde 1",
    );
    assert.equal(neutralWording("How a crew night works"), "How a gaming session works");
    assert.equal(neutralWording("It&#x27;s on tonight"), "It&#x27;s on today");
    const code = '<span data-t="night.h1" class="fa-night"><a href="/night/AB">x</a></span>';
    assert.equal(neutralWording(code), code);
  });

  it("keeps German articles agreeing with the feminine Zockrunde in every phrase it swaps", () => {
    const swapped: [string, string][] = [
      ["So läuft ein Crew-Abend", "So läuft eine Zockrunde"],
      ["Max lädt dich zum Crew-Abend ein", "Max lädt dich zur Zockrunde ein"],
      ["Max hat einen Crew-Abend organisiert", "Max hat eine Zockrunde organisiert"],
      ["Um 21 Uhr startet euer Crew-Abend.", "Um 21 Uhr startet eure Zockrunde."],
      ["dann erinnern wir dich vor jedem Crew-Abend.", "dann erinnern wir dich vor jeder Zockrunde."],
      ["Erinnerungen an Crew-Abende: kurz bestätigen", "Erinnerungen an Zockrunden: kurz bestätigen"],
      ["Du willst an Crew-Abende erinnert werden?", "Du willst an Zockrunden erinnert werden?"],
      ["Erinnerung vor Crew-Abenden per Mail?", "Erinnerung vor Zockrunden per Mail?"],
      [
        "an eure Crew-Abende (zum Beispiel, wenn ein Abend angesagt wird, und am Tag selbst)",
        "an eure Zockrunden (zum Beispiel, wenn eine Zockrunde angesagt wird, und am Tag selbst)",
      ],
      ["<dt>Der Abend</dt>", "<dt>Die Zockrunde</dt>"],
      ["Abend ansagen", "Zockrunde ansagen"],
      ["Zwei Testabende à drei Stunden", "Zwei Testrunden à drei Stunden"],
      ["eine Crew für unsere Zockabende gegründet", "eine Crew für unsere Zockrunden gegründet"],
      ["Crew-Abend am Freitag: Max, Lena und du", "Zockrunde am Freitag: Max, Lena und du"],
    ];
    for (const [from, to] of swapped) assert.equal(neutralWording(from), to, from);
  });
});
