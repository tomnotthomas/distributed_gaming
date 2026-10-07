// The marketing site (marketing.ts). Most tests serve the real pages in
// web/marketing/ in-process; the last start the real server with MARKETING_PAGES off and on.

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assetPath,
  createMarketing,
  inviteRoute,
  marketingFiles,
  pageRoutes,
  renderInvite,
  setText,
  siteFromEnv,
} from "../marketing.js";
import { startServer, stopServer } from "./child.js";

const DIR = fileURLToPath(new URL("../../../web/marketing/", import.meta.url));
const SITE = { origin: "https://lanterel.test", host: "lanterel.test", app: "https://app.lanterel.test" };
/** The example people and facts marketing built the invite pages with. */
const EXAMPLES =
  /\b(Max|Lena|Lenas|Lena's|Jonas|Jonas's|Tom|Toms|Tom's|Berlin|Freitag|Friday|Oktober|October)\b/;

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A request to `origin` as if for `host`, which fetch() cannot set. */
function ask(
  origin: string,
  path: string,
  { host = SITE.host, method = "GET", body = "" } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request(
      url,
      {
        method,
        headers: {
          host,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A GET for `path` exactly as written, past the URL parser's normalizing of dot segments. */
function askRaw(origin: string, path: string, host = SITE.host): Promise<Answer> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: "GET", headers: { host } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("marketing configuration", () => {
  it("is off unless MARKETING_PAGES=on, and on only with a usable SITE_ORIGIN and app origin", () => {
    const app = "https://app.lanterel.de";
    assert.equal(siteFromEnv({}, app), null);
    assert.equal(siteFromEnv({ SITE_ORIGIN: "https://lanterel.de" }, app), null);
    assert.equal(siteFromEnv({ MARKETING_PAGES: "on" }, app), null);
    assert.equal(siteFromEnv({ MARKETING_PAGES: "on", SITE_ORIGIN: "ftp://lanterel.de" }, app), null);
    assert.equal(siteFromEnv({ MARKETING_PAGES: "on", SITE_ORIGIN: "https://lanterel.de" }, null), null);
    assert.deepEqual(siteFromEnv({ MARKETING_PAGES: "on", SITE_ORIGIN: "https://lanterel.de/x" }, app), {
      origin: "https://lanterel.de",
      host: "lanterel.de",
      app,
    });
  });

  it("maps each page folder to its route, German and English, as the handoff lists them", async () => {
    const routes = await pageRoutes(DIR);
    assert.deepEqual(Object.fromEntries([...routes].sort()), {
      "/": "index.html",
      "/datenschutz/": "datenschutz/index.html",
      "/en/": "en/index.html",
      "/en/host/": "en/host/index.html",
      "/en/lanterel-os/": "en/lanterel-os/index.html",
      "/en/legal-notice/": "en/legal-notice/index.html",
      "/en/privacy/": "en/privacy/index.html",
      "/host/": "host/index.html",
      "/impressum/": "impressum/index.html",
      "/lanterel-os/": "lanterel-os/index.html",
    });
  });

  it("resolves the invite routes and refuses codes the product never makes", () => {
    assert.deepEqual(inviteRoute("/crew/AB12_cd-9"), { type: "crew", lang: "de", code: "AB12_cd-9" });
    assert.deepEqual(inviteRoute("/en/night/x/"), { type: "night", lang: "en", code: "x" });
    assert.deepEqual(inviteRoute("/gift/"), { type: "gift", lang: "de", code: null });
    assert.deepEqual(inviteRoute("/en/seat"), { type: "seat", lang: "en", code: null });
    assert.equal(inviteRoute("/crew/a.b"), null);
    assert.equal(inviteRoute("/crew/a/b"), null);
    assert.equal(inviteRoute(`/crew/${"a".repeat(129)}`), null);
    assert.equal(inviteRoute("/de/crew/x"), null);
    assert.equal(inviteRoute("/crewx/x"), null);
  });

  it("replaces an element's inner HTML by its data-t key, nested tags included", () => {
    const html =
      '<h1 data-t="a" id="h">Max <b>x</b></h1><p data-t="b"><span>y</span></p><h1 data-t="a">z</h1>';
    assert.equal(
      setText(html, "a", "Hi <b>there</b>"),
      '<h1 data-t="a" id="h">Hi <b>there</b></h1><p data-t="b"><span>y</span></p><h1 data-t="a">Hi <b>there</b></h1>',
    );
  });
});

describe("marketing site", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const files = marketingFiles(DIR, SITE);
    const routes = await pageRoutes(DIR);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const serve = createMarketing({ site: SITE, files, routes });
      if (await serve(req, res, url)) return;
      res.writeHead(418).end("the app");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves every page with the brand and the site's origin filled in", async () => {
    for (const path of (await pageRoutes(DIR)).keys()) {
      const page = await ask(origin, path);
      assert.equal(page.status, 200, path);
      assert.match(String(page.headers["content-type"]), /text\/html/);
      assert.match(page.body, /Lanterel/, path);
      // The old name nowhere a reader sees it (a script's event name may keep it).
      assert.doesNotMatch(page.body, /\{\{|\bSwiff|\bSWIFF\b/, path);
      assert.match(page.body, new RegExp(`<link rel="canonical" href="${SITE.origin}${path}">`), path);
      assert.doesNotMatch(page.body, /onrender\.com/, path);
      // No page asks for an email address: no waitlist, no sign-up form.
      assert.doesNotMatch(page.body, /<form\b|type="email"|form-endpoint/, path);
    }
  });

  it("links the library check into the app at its configured origin", async () => {
    assert.match(
      (await ask(origin, "/")).body,
      new RegExp(`<a href="${SITE.app}/" data-t="lib.check">Prüf deine Bibliothek</a>`),
    );
    assert.match(
      (await ask(origin, "/en/")).body,
      new RegExp(`<a href="${SITE.app}/" data-t="lib.check">Check your library</a>`),
    );
  });

  it("sends a page path without its slash to the page", async () => {
    const moved = await ask(origin, "/host?x=1");
    assert.equal(moved.status, 308);
    assert.equal(moved.headers.location, "/host/?x=1");
    assert.equal((await ask(origin, "/en/legal-notice")).headers.location, "/en/legal-notice/");
  });

  it("serves its assets, robots.txt and sitemap, and nothing it keeps for the server", async () => {
    const css = await ask(origin, "/assets/css/base.css");
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /text\/css/);
    assert.equal((await ask(origin, "/assets/img/hero-730.jpg")).headers["content-type"], "image/jpeg");
    assert.match((await ask(origin, "/robots.txt")).body, new RegExp(`Sitemap: ${SITE.origin}/sitemap.xml`));
    assert.match((await ask(origin, "/sitemap.xml")).body, new RegExp(`<loc>${SITE.origin}/</loc>`));
    for (const path of [
      "/content/og.json",
      "/content/invite-texts.json",
      "/assets/../../../package.json",
      "/assets/%2e%2e/%2e%2e/%2e%2e/package.json",
      "/assets/app-bundle-nope.js",
    ]) {
      assert.equal((await ask(origin, path)).body, "the app", path);
    }
    // Sent as written: dot segments and encoded separators never leave assets/.
    for (const path of [
      "/assets/../content/og.json",
      "/assets/..%2fcontent/og.json",
      "/assets/..%2Fcontent%2Finvite-texts.json",
      "/assets/%2e%2e/crew/index.html",
      "/assets/css/..%2f..%2fcrew/index.html",
      "/assets/..%5ccontent%5cog.json",
      "/assets/css/%00base.css",
      "/assets/%E0%A4%A",
    ]) {
      assert.equal((await askRaw(origin, path)).body, "the app", path);
    }
    assert.equal((await askRaw(origin, "/assets/css/base.css")).status, 200);
  });

  it("finds an asset only under assets/, however its path is spelled", () => {
    assert.equal(assetPath("/assets/css/base.css"), "assets/css/base.css");
    assert.equal(assetPath("/assets/img/a%20b.jpg"), "assets/img/a b.jpg");
    assert.equal(assetPath("/robots.txt"), "robots.txt");
    for (const path of [
      "/assets/../index.html",
      "/assets/..%2findex.html",
      "/assets/%2e%2e/index.html",
      "/assets/.%2e/index.html",
      "/assets/css/./base.css",
      "/assets//css/base.css",
      "/assets/..%5cindex.html",
      "/assets/%00",
      "/assets/%E0%A4%A",
      "/content/x.json",
    ]) {
      assert.equal(assetPath(path), null, path);
    }
  });

  it("reads nothing outside the marketing root, whatever path it is asked for", async () => {
    const files = marketingFiles(DIR, SITE);
    assert.ok(await files.read("assets/css/base.css"));
    for (const rel of ["../package.json", "assets/../../package.json", "/etc/passwd", "..", ""]) {
      assert.equal(await files.read(rel), null, rel);
    }
  });
  it("never says when a crew plays: no evening or night in a page or a preview", async () => {
    const TIME_OF_DAY = /(Abende?n?s?\b|abend|\b(?:Nacht|nachts|[Nn]ights?|[Tt]onight|[Ee]venings?)\b)/;
    const files: string[] = [];
    /** Collect every page, text and JSON file under `dir` into `files`. */
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(html|txt|json)$/.test(entry.name)) files.push(path);
      }
    };
    walk(DIR);
    assert.ok(files.length > 10);
    for (const path of files) {
      const text = readFileSync(path, "utf8")
        // What a reader sees: no tags, styles or scripts, no URLs (/night/ is a route), no data-t keys.
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\{\{\w+\}\}\S*|https?:\/\/\S+|\/[\w/-]*night[\w/-]*/g, " ")
        .replace(/"[\w.]*night[\w.]*"\s*:/g, " ");
      assert.doesNotMatch(text, TIME_OF_DAY, relative(DIR, path));
    }
  });

  it("writes German with articles agreeing with the feminine Zockrunde and Testrunde everywhere it swapped them", () => {
    const WRONG =
      /\b(der|den|dem|des|ein|einen|einem|eines|kein|keinen|keinem|jeden|jedem|jedes|euer|eurem|euren|dein|deinen|deinem|unser|unseren|unserem|zum|vom|beim|im)\s+(Zock|Test)runde\b/i;
    const german: string[] = [];
    /** Collect every German file under `dir` into `german`. */
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(html|txt|json|md)$/.test(entry.name)) german.push(path);
      }
    };
    walk(DIR);
    let swapped = 0;
    for (const path of german) {
      const rel = relative(DIR, path);
      if (rel.startsWith("en/") || rel.includes(".en.")) continue;
      const text = readFileSync(path, "utf8").replace(/<[^>]*>/g, " ");
      swapped += (text.match(/(Zock|Test)runden?/g) ?? []).length;
      assert.doesNotMatch(text, WRONG, rel);
    }
    assert.ok(swapped > 20, "the German pages say Zockrunde");
  });

  it("leaves every other host to the app", async () => {
    for (const path of ["/", "/en/", "/share/", "/host/", "/crew/AB12", "/assets/css/base.css"]) {
      assert.equal((await ask(origin, path, { host: "swiff.onrender.com" })).body, "the app", path);
    }
  });

  it("hands a crew or seat code to the app's own invite page, which names who asks", async () => {
    for (const lang of ["", "/en"]) {
      const crew = await ask(origin, `${lang}/crew/AB12cd`);
      assert.equal(crew.status, 302);
      assert.equal(crew.headers.location, `${SITE.app}/invite/AB12cd`);
      assert.equal(crew.headers["referrer-policy"], "no-referrer");
      assert.equal(crew.headers["cache-control"], "no-store");
      assert.equal((await ask(origin, `${lang}/seat/S3at_1`)).headers.location, `${SITE.app}/seat/S3at_1`);
    }
    assert.equal((await ask(origin, "/crew/a.b")).body, "the app");
  });

  it("renders gift and Night invites, which the product does not have yet, naming nobody, into the app's sign-in", async () => {
    for (const type of ["gift", "night"]) {
      for (const lang of ["", "/en"]) {
        const path = `${lang}/${type}/AB12cd`;
        const page = await ask(origin, path);
        assert.equal(page.status, 200, path);
        assert.equal(page.headers["x-robots-tag"], "noindex");
        assert.match(page.body, /<meta name="robots" content="noindex">/);
        assert.doesNotMatch(page.body, EXAMPLES, path);
        assert.doesNotMatch(page.body, /\{\{|Swiff/, path);
        assert.match(page.body, /<title>[^<]+ \| Lanterel<\/title>/, path);
        assert.match(page.body, new RegExp(`href="${SITE.app}/auth/steam/login\\?to=%2Fcrews"`), path);
      }
    }
    // A template's own path, with no code: the same neutral page.
    for (const type of ["gift", "night"]) {
      const bare = await ask(origin, `/${type}/`);
      assert.equal(bare.status, 200, type);
      assert.doesNotMatch(bare.body, EXAMPLES, type);
    }
  });

  it("asks no email on a gift page: its first step is Steam sign-in", async () => {
    assert.match((await ask(origin, "/gift/G1ft")).body, /data-t="gift.s1p">Mit Steam anmelden\./);
    assert.match((await ask(origin, "/en/gift/G1ft")).body, /data-t="gift.s1p">Sign in with Steam\./);
    assert.doesNotMatch((await ask(origin, "/en/privacy/")).body, /\)\. \//);
  });

  it("sends the crew page on to the app, behind its Steam sign-in", async () => {
    for (const path of ["/share/", "/en/share/"]) {
      const moved = await ask(origin, path);
      assert.equal(moved.status, 302, path);
      assert.equal(moved.headers.location, `${SITE.app}/crews`, path);
    }
  });

  it("renders an invite template's copy and leaves its links as marketing built them", () => {
    const template =
      '<title>x</title><meta name="description" content="x"><a href="{{app}}/auth/steam/login?to=%2Fcrews">y</a>';
    const html = renderInvite(template, "gift", "en");
    assert.match(html, /<title>[^<]+ \| \{\{brand\}\}<\/title>/);
    assert.match(html, /<a href="\{\{app\}\}\/auth\/steam\/login\?to=%2Fcrews">y<\/a>/);
  });
});

describe("MARKETING_PAGES on the real server", () => {
  /** The site's own host: what tells it from the app is the host a request names, not the port. */
  const HOST = "lanterel.localhost";
  let server: ChildProcess | null = null;
  /** The server started last, and the host a request names to reach the app on it. */
  let HTTP = "";
  let APP = "";

  /** Start the real server with `env` and wait until it listens. */
  async function start(env: Record<string, string>) {
    await stop();
    const started = await startServer(
      { SWIFF_PLAYABILITY: "off", DATABASE_URL: "", ...env },
      { from: 10_300, span: 300 },
    );
    server = started.child;
    HTTP = `http://127.0.0.1:${started.port}`;
    APP = `127.0.0.1:${started.port}`;
  }

  /** Stop the server started last. */
  async function stop() {
    if (server) await stopServer(server);
    server = null;
  }

  after(stop);

  it("off: the site's routes behave as before, and nothing takes a sign-up", async () => {
    await start({ SITE_ORIGIN: `http://${HOST}` });
    try {
      for (const path of ["/", "/host/", "/crew/AB12", "/robots.txt"]) {
        const page = await ask(HTTP, path, { host: HOST });
        // The app's answer, whatever it is: its page when web/dist is built,
        // its not-built notice when not.
        const app = await ask(HTTP, path, { host: APP });
        assert.deepEqual([page.status, page.body], [app.status, app.body], path);
        // And nothing of the site's: its pages carry data-t keys and its
        // origin, which the app has neither of.
        assert.doesNotMatch(page.body, /data-t="|form-endpoint/, path);
        assert.ok(!page.body.includes(`http://${HOST}`), path);
      }
      const posted = await ask(HTTP, "/api/signups", {
        host: HOST,
        method: "POST",
        body: JSON.stringify({ email: "a@b.de", kind: "player" }),
      });
      assert.equal(posted.status, 404);
    } finally {
      await stop();
    }
  });

  it("on: the site on its own host, the app everywhere else", async () => {
    await start({
      MARKETING_PAGES: "on",
      SITE_ORIGIN: `http://${HOST}`,
      PUBLIC_ORIGIN: "https://app.lanterel.test",
    });
    try {
      const landing = await ask(HTTP, "/", { host: HOST });
      assert.equal(landing.status, 200);
      assert.match(landing.body, /<a href="https:\/\/app\.lanterel\.test\/" data-t="lib.check">/);
      assert.match(
        landing.body,
        /href="https:\/\/app\.lanterel\.test\/auth\/steam\/login\?to=%2Fcrews%3Ffound%3D1"/,
      );
      assert.match(landing.body, new RegExp(`<link rel="canonical" href="http://${HOST}/">`));
      assert.doesNotMatch((await ask(HTTP, "/", { host: APP })).body, /lanterel\.localhost/);
      const invite = await ask(HTTP, "/en/crew/AB12", { host: HOST });
      assert.equal(invite.headers.location, "https://app.lanterel.test/invite/AB12");
    } finally {
      await stop();
    }
  });
});
