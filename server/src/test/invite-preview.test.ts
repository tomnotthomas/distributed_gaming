// The link previews of the app's crew and seat links (invite-preview.ts).

import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cardFile,
  invitePreview,
  previewCard,
  previewLang,
  previewPath,
  readPreviews,
} from "../invite-preview.js";

const MARKETING = fileURLToPath(new URL("../../../web/marketing/", import.meta.url));

const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Lanterel</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const COPY = {
  title: "Komm in die Crew",
  title_named: "{name} holt dich in die Crew",
  desc: "Zocken mit Freunden, auch auf dem Mac.",
};

/** A request asking for `language` first. */
const asking = (language?: string) =>
  ({ headers: language === undefined ? {} : { "accept-language": language } }) as IncomingMessage;

describe("invite link previews", () => {
  it("finds a crew or seat link's token, and nothing on any other path", () => {
    assert.deepEqual(previewPath("/invite/AB12_cd-"), { type: "crew", token: "AB12_cd-" });
    assert.deepEqual(previewPath("/seat/S3at/"), { type: "rig", token: "S3at" });
    for (const path of ["/invite", "/invite/", "/invite/a.b", "/invite/a/b", "/seats/AB", "/crews/x"]) {
      assert.equal(previewPath(path), null, path);
    }
  });

  it("serves only the crew and seat cards, by their exact names", () => {
    assert.equal(previewCard("crew", "de"), "og-crew-de.jpg");
    assert.equal(cardFile("/og/og-rig-en.jpg"), "og-rig-en.jpg");
    for (const path of [
      "/og/og-night-de.jpg",
      "/og/../package.json",
      "/og/og-crew-de.png",
      "/og/og-crew-fr.jpg",
    ]) {
      assert.equal(cardFile(path), null, path);
    }
  });

  it("speaks English to a reader who asks for it first, German to everyone else", () => {
    assert.equal(previewLang(asking("en-GB,de;q=0.8")), "en");
    assert.equal(previewLang(asking("de-DE,en;q=0.8")), "de");
    assert.equal(previewLang(asking()), "de");
  });

  it("names who asks in the title and Open Graph tags, escaped, never the token", () => {
    const html = invitePreview(APP_HTML, COPY, 'Ana <b>"$&"</b>', "de", "https://app.test/og/og-crew-de.jpg");
    assert.match(html, /<html lang="de"/);
    assert.match(html, /<title>Ana &lt;b&gt;&quot;\$&amp;&quot;&lt;\/b&gt; holt dich in die Crew<\/title>/);
    assert.match(
      html,
      /<meta property="og:title" content="Ana &lt;b&gt;&quot;\$&amp;&quot;&lt;\/b&gt; holt dich in die Crew" \/>/,
    );
    assert.match(html, /<meta property="og:image" content="https:\/\/app.test\/og\/og-crew-de.jpg" \/>/);
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.match(html, /<div id="root"><\/div>/);
  });

  it("names nobody when the link names nobody", () => {
    const html = invitePreview(APP_HTML, COPY, null, "en", "https://app.test/og/og-crew-en.jpg");
    assert.match(html, /<meta property="og:title" content="Komm in die Crew" \/>/);
  });

  it("reads the crew and seat previews from the launch set, in both languages, with no meetup time", async () => {
    const previews = await readPreviews(MARKETING);
    assert.ok(previews);
    for (const type of ["crew", "rig"] as const) {
      for (const lang of ["de", "en"] as const) {
        const copy = previews[type][lang];
        assert.match(copy.title_named, /\{name\}/, `${type} ${lang}`);
        assert.doesNotMatch(JSON.stringify(copy), /Abend|night|evening/i, `${type} ${lang}`);
      }
    }
    assert.equal(await readPreviews("/nonexistent"), null);
  });
});
