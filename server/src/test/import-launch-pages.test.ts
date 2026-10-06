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
const { faqJsonLd } = (await import(SCRIPT)) as { faqJsonLd: FaqJsonLd };

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

  it("leaves a page without FAQ structured data, or without a visible FAQ, as it is", () => {
    assert.equal(faqJsonLd("<p>no faq</p>", "en"), "<p>no faq</p>");
    const bare = PAGE.slice(0, PAGE.indexOf("<body>"));
    assert.equal(faqJsonLd(bare, "en"), bare);
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
});
