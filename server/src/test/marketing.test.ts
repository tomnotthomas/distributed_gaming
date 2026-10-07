// The marketing site (marketing.ts) and the reminders (signups.ts). Most tests
// serve the real pages in web/marketing/ in-process, on a database of their
// own; the last start the real server with MARKETING_PAGES off and on.

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Database } from "../db.js";
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
import { migrate } from "../schema.js";
import { CLIENT_BURST, clientOf, createSignups, RESEND_AFTER_MS, type Signups } from "../signups.js";
import { startServer, stopServer } from "./child.js";
import { testDatabase } from "./db.js";

const DIR = fileURLToPath(new URL("../../../web/marketing/", import.meta.url));
const SITE = { origin: "https://lanterel.test", host: "lanterel.test", app: "https://app.lanterel.test" };
/** The app's host, where the crew page asks for reminders. */
const APP_HOST = new URL(SITE.app).host;
/** The header the in-process server reads a signed-in player's Steam id from, standing in for the session cookie. */
const RENTER = "x-test-renter";
/** The example people and facts marketing built the invite pages with. */
const EXAMPLES =
  /\b(Max|Lena|Lenas|Lena's|Jonas|Jonas's|Tom|Toms|Tom's|Berlin|Freitag|Friday|Oktober|October)\b/;

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A request to `origin` as if for `host`, which fetch() cannot set. */
function ask(
  origin: string,
  path: string,
  { host = SITE.host, method = "GET", body = "", localAddress = "127.0.0.1", renter = "" } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request(
      url,
      {
        method,
        localAddress,
        headers: {
          host,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(renter ? { [RENTER]: renter } : {}),
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
  let db: Database;
  let now: number;
  let signups: Signups;
  let server: Server;
  let origin: string;

  /** The mails in the outbox, oldest first. */
  const outbox = async () =>
    (
      await db.query<{ to_address: string; template: string; subject: string; html: string; text: string }>(
        "SELECT to_address, template, subject, html, text FROM marketing_outbox ORDER BY created_at, id",
      )
    ).rows;

  /** Ask for reminders as `renter` on the app's host, a second later than whatever came before. */
  async function remind(body: Record<string, unknown>, renter = "765611") {
    now += 1_000;
    return ask(origin, "/api/signups/reminders", {
      host: APP_HOST,
      method: "POST",
      body: JSON.stringify(body),
      renter,
    });
  }

  /** `renter`'s reminders as the crew page reads them. */
  const reminders = async (renter = "765611") =>
    JSON.parse((await ask(origin, "/api/signups/reminders", { host: APP_HOST, renter })).body);

  /** A link's page or button on the app's host, where the mails point. */
  const link = (path: string, method = "GET") => ask(origin, path, { host: APP_HOST, method });

  /** Press the button a confirm link's page has, a second later than whatever came before. */
  async function confirm(token: string) {
    now += 1_000;
    return link(`/api/signups/confirm?token=${token}`, "POST");
  }

  /** The sign-ups as kept. */
  const signupRows = async () =>
    (await db.query<Record<string, unknown>>("SELECT * FROM marketing_signups ORDER BY id")).rows;

  /** The token in the last mail's link to `action`. */
  async function linkToken(action: string): Promise<string> {
    const mails = await outbox();
    const match = new RegExp(`/api/signups/${action}\\?token=([\\w-]+)`).exec(mails.at(-1)!.text);
    assert.ok(match, `the last mail links to ${action}`);
    return match[1]!;
  }

  before(async () => {
    const files = marketingFiles(DIR, SITE);
    const routes = await pageRoutes(DIR);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await signups.serve(req, res, url)) return;
      const serve = createMarketing({ site: SITE, files, routes });
      if (await serve(req, res, url)) return;
      res.writeHead(418).end("the app");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(async () => {
    await db?.close();
    db = await testDatabase();
    await migrate(db);
    now = 1_800_000_000_000;
    signups = createSignups({
      database: db,
      site: SITE,
      files: marketingFiles(DIR, SITE),
      now: () => now,
      renter: (req) => (req.headers[RENTER] as string | undefined) ?? null,
    });
  });

  after(() => db?.close());

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
      "/emails/signup_confirm.de.html",
      "/content/invite-texts.json",
      "/assets/../../../package.json",
      "/assets/%2e%2e/%2e%2e/%2e%2e/package.json",
      "/assets/app-bundle-nope.js",
    ]) {
      assert.equal((await ask(origin, path)).body, "the app", path);
    }
    // Sent as written: dot segments and encoded separators never leave assets/.
    for (const path of [
      "/assets/../emails/signup_confirm.de.html",
      "/assets/..%2femails/signup_confirm.de.html",
      "/assets/..%2Fcontent%2Finvite-texts.json",
      "/assets/%2e%2e/crew/index.html",
      "/assets/css/..%2f..%2fcrew/index.html",
      "/assets/..%5cemails%5csignup_confirm.de.html",
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
      "/emails/x.html",
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

  it("takes reminders and their links only on the app's own host, where the crew page and its session are", async () => {
    const body = JSON.stringify({ email: "ana@example.com" });
    for (const host of [SITE.host, "evil.example"]) {
      const asked = await ask(origin, "/api/signups/reminders", {
        host,
        method: "POST",
        body,
        renter: "765611",
      });
      assert.notEqual(asked.status, 200, host);
      assert.equal((await ask(origin, "/api/signups/confirm?token=x", { host })).body, "the app");
    }
    assert.deepEqual(await signupRows(), []);
    // Nor any sign-up of the old waitlist: there is none.
    const waitlist = await ask(origin, "/api/signups", {
      host: APP_HOST,
      method: "POST",
      body: JSON.stringify({ email: "ana@example.com", kind: "player" }),
    });
    assert.notEqual(waitlist.status, 202);
    assert.equal((await remind({ email: "ana@example.com" })).status, 200);
  });

  it("lets one client ask only a few times at once, and not take the others' turn", async () => {
    /** Ask for reminders to `email` from `localAddress`, a client of its own. */
    const send = (email: string, localAddress = "127.0.0.1") =>
      ask(origin, "/api/signups/reminders", {
        host: APP_HOST,
        method: "POST",
        body: JSON.stringify({ email }),
        localAddress,
        renter: "765611",
      });
    const sent = [];
    for (let i = 0; i < CLIENT_BURST + 2; i++) sent.push((await send(`a${i}@example.com`)).status);
    assert.deepEqual(sent, [...Array<number>(CLIENT_BURST).fill(200), 429, 429]);
    assert.equal((await send("b@example.com", "127.0.0.2")).status, 200);
  });

  it("knows a client by the address that connected, or by what a trusted proxy appended last", () => {
    /** A request from `remoteAddress` carrying `forwarded` as its X-Forwarded-For. */
    const req = (forwarded: string | undefined, remoteAddress = "10.0.0.1") =>
      ({
        headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
        socket: { remoteAddress },
      }) as never;
    assert.equal(clientOf(req("1.2.3.4"), false), "10.0.0.1");
    assert.equal(clientOf(req("6.6.6.6, 1.2.3.4"), true), "1.2.3.4");
    assert.equal(clientOf(req(undefined), true), "10.0.0.1");
    assert.equal(clientOf(req(""), true), "10.0.0.1");
  });

  it("never says when a crew plays: no evening or night in a page, a mail or a preview", async () => {
    const TIME_OF_DAY = /(Abende?n?s?\b|abend|\b(?:Nacht|nachts|[Nn]ights?|[Tt]onight|[Ee]venings?)\b)/;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(html|txt|json)$/.test(entry.name)) files.push(path);
      }
    };
    walk(DIR);
    assert.ok(files.length > 20);
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

  it("keeps a signed-in player's reminders, double opt-in, back to the crew page", async () => {
    assert.equal((await ask(origin, "/api/signups/reminders", { host: APP_HOST })).status, 401);
    assert.equal((await remind({ email: "sam@example.com" }, "")).status, 401);
    assert.deepEqual(await reminders(), { email: null, confirmed: false });

    const asked = await remind({ email: " Sam@Example.com ", lang: "en" });
    assert.equal(asked.status, 200);
    assert.deepEqual(JSON.parse(asked.body), { email: "sam@example.com", confirmed: false });
    let mails = await outbox();
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to_address, "sam@example.com");
    assert.equal(mails[0]!.template, "signup_confirm");
    assert.equal(mails[0]!.subject, "Confirm your session reminders");
    assert.match(mails[0]!.text, new RegExp(`${SITE.app}/api/signups/confirm\\?token=`));
    assert.match(mails[0]!.text, new RegExp(`${SITE.app}/api/signups/unsubscribe\\?token=`));

    // Asked again at once: no second mail.
    await remind({ email: "sam@example.com", lang: "en" });
    assert.equal((await outbox()).length, 1);

    const confirmed = await confirm(await linkToken("confirm"));
    assert.equal(confirmed.status, 303);
    assert.equal(confirmed.headers.location, `${SITE.app}/crews#reminders=on`);
    assert.deepEqual(await reminders(), { email: "sam@example.com", confirmed: true });
    const [row] = await signupRows();
    assert.equal(row!.kind, "reminders");
    assert.equal(row!.steam_id, "765611");

    // Another player may use the same address.
    assert.equal((await remind({ email: "sam@example.com" }, "999")).status, 200);
    assert.equal((await signupRows()).length, 2);

    // A new address starts over, and nothing goes to it until it confirms.
    mails = await outbox();
    assert.deepEqual(JSON.parse((await remind({ email: "sam@new.example" })).body), {
      email: "sam@new.example",
      confirmed: false,
    });
    assert.equal((await outbox()).length, mails.length + 1);

    const off = await ask(origin, "/api/signups/reminders/off", {
      host: APP_HOST,
      method: "POST",
      renter: "765611",
    });
    assert.deepEqual(JSON.parse(off.body), { email: null, confirmed: false });
  });

  it("sends the confirm mail again only after a while, and says when to ask again", async () => {
    await remind({ email: "bo@example.com" });
    const sentAt = now;
    assert.deepEqual(JSON.parse((await remind({ email: "bo@example.com" })).body), {
      email: "bo@example.com",
      confirmed: false,
      retryAt: sentAt + RESEND_AFTER_MS,
    });
    assert.equal((await outbox()).length, 1);
    now += RESEND_AFTER_MS;
    await remind({ email: "bo@example.com" });
    assert.equal((await outbox()).length, 2);
  });

  it("mails a corrected address at once, but an address switched back to only after a while", async () => {
    await remind({ email: "a@example.com" });
    const firstConfirm = await linkToken("confirm");
    const sentAt = now;
    assert.deepEqual(JSON.parse((await remind({ email: "b@example.com" })).body), {
      email: "b@example.com",
      confirmed: false,
    });
    const back = JSON.parse((await remind({ email: "a@example.com" })).body);
    assert.deepEqual(back, { email: "a@example.com", confirmed: false, retryAt: sentAt + RESEND_AFTER_MS });
    assert.deepEqual(
      (await outbox()).map((m) => m.to_address),
      ["a@example.com", "b@example.com"],
    );
    // The link mailed before the switch confirms nothing: the address starts over.
    await confirm(firstConfirm);
    assert.deepEqual(await reminders(), { email: "a@example.com", confirmed: false });

    now = sentAt + RESEND_AFTER_MS;
    await remind({ email: "a@example.com" });
    assert.deepEqual(
      (await outbox()).map((m) => m.to_address),
      ["a@example.com", "b@example.com", "a@example.com"],
    );
    await confirm(await linkToken("confirm"));
    assert.deepEqual(await reminders(), { email: "a@example.com", confirmed: true });
  });

  it("sends no second confirm mail within the while by stopping the reminders and asking again", async () => {
    /** Stop the player's reminders. */
    const off = () =>
      ask(origin, "/api/signups/reminders/off", { host: APP_HOST, method: "POST", renter: "765611" });
    await remind({ email: "fay@example.com" });
    const sentAt = now;
    await confirm(await linkToken("confirm"));
    await off();
    const again = JSON.parse((await remind({ email: "fay@example.com" })).body);
    assert.deepEqual(again, {
      email: "fay@example.com",
      confirmed: false,
      retryAt: sentAt + RESEND_AFTER_MS,
    });
    assert.equal((await outbox()).length, 1);

    // Stopped, it needs confirming afresh.
    now = sentAt + RESEND_AFTER_MS;
    await remind({ email: "fay@example.com" });
    assert.equal((await outbox()).length, 2);
    await confirm(await linkToken("confirm"));
    assert.deepEqual(await reminders(), { email: "fay@example.com", confirmed: true });
  });

  it("counts stopping the reminders against the client's budget", async () => {
    const statuses = [];
    for (let i = 0; i < CLIENT_BURST + 1; i++)
      statuses.push(
        (
          await ask(origin, "/api/signups/reminders/off", {
            host: APP_HOST,
            method: "POST",
            renter: "765611",
          })
        ).status,
      );
    assert.deepEqual(statuses, [...Array<number>(CLIENT_BURST).fill(200), 429]);
  });

  it("gives a new address its own unsubscribe link, so one mailed to the old address cannot stop it", async () => {
    await remind({ email: "old@example.com" });
    const oldUnsubscribe = await linkToken("unsubscribe");
    await remind({ email: "new@example.com" });
    const newUnsubscribe = await linkToken("unsubscribe");
    assert.notEqual(newUnsubscribe, oldUnsubscribe);
    await confirm(await linkToken("confirm"));

    assert.equal((await link(`/api/signups/unsubscribe?token=${oldUnsubscribe}`, "POST")).status, 404);
    assert.deepEqual(await reminders(), { email: "new@example.com", confirmed: true });
    assert.equal((await link(`/api/signups/unsubscribe?token=${newUnsubscribe}`, "POST")).status, 200);
    assert.deepEqual(await reminders(), { email: null, confirmed: false });
  });

  it("refuses what is not an address and lands a bad link on the crew page", async () => {
    assert.equal((await remind({ email: "nope" })).status, 400);
    assert.equal((await remind({ email: `${"a".repeat(250)}@x.de` })).status, 400);
    assert.equal(
      (
        await ask(origin, "/api/signups/reminders", {
          host: APP_HOST,
          method: "POST",
          body: "[",
          renter: "1",
        })
      ).status,
      400,
    );
    assert.equal((await outbox()).length, 0);
    const bad = await confirm("forged");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, `${SITE.app}/crews`);
    assert.equal((await link("/api/signups/unsubscribe?token=forged", "POST")).status, 404);
    // A link nobody knows says so in both languages, with nothing to press.
    for (const action of ["confirm", "unsubscribe"]) {
      const unknown = await link(`/api/signups/${action}?token=%22%3E%3Cscript%3E`);
      assert.equal(unknown.status, 404);
      assert.match(unknown.body, /Dieser Link ist ungültig. · This link is not valid./);
      assert.doesNotMatch(unknown.body, /<form|<button|<script>/);
    }
  });

  it("only asks on a link's GET, which mail scanners open too: nothing changes", async () => {
    await remind({ email: "dee@example.com", lang: "en" });
    const confirmToken = await linkToken("confirm");
    const unsubscribeToken = await linkToken("unsubscribe");
    const before = await signupRows();

    const asked = await link(`/api/signups/confirm?token=${confirmToken}`);
    assert.equal(asked.status, 200);
    assert.equal(asked.headers["cache-control"], "no-store");
    assert.match(asked.body, new RegExp(`<a class="wordmark" href="${SITE.app}/crews">LANTEREL</a>`));
    assert.match(asked.body, new RegExp(`<link rel="stylesheet" href="${SITE.origin}/assets/css/base.css">`));
    assert.match(
      asked.body,
      new RegExp(
        `<form method="post" action="/api/signups/confirm\\?token=${confirmToken}"><button[^>]*>Confirm</button>`,
      ),
    );
    assert.doesNotMatch(asked.body, /Bestätigen/);
    const leave = await link(`/api/signups/unsubscribe?token=${unsubscribeToken}`);
    assert.match(
      leave.body,
      new RegExp(
        `<form method="post" action="/api/signups/unsubscribe\\?token=${unsubscribeToken}"><button[^>]*>Unsubscribe</button>`,
      ),
    );

    assert.deepEqual(await signupRows(), before);
    assert.deepEqual(
      (await outbox()).map((m) => m.template),
      ["signup_confirm"],
    );
  });

  it("does not confirm with a link a week old", async () => {
    await remind({ email: "late@example.com" });
    now += 8 * 24 * 60 * 60_000;
    // Its page says it is not valid, with nothing to press; the unsubscribe link still works.
    const asked = await link(`/api/signups/confirm?token=${await linkToken("confirm")}`);
    assert.equal(asked.status, 404);
    assert.match(asked.body, /Dieser Link ist ungültig. · This link is not valid./);
    assert.doesNotMatch(asked.body, /<form|<button/);
    const leave = await link(`/api/signups/unsubscribe?token=${await linkToken("unsubscribe")}`);
    assert.equal(leave.status, 200);
    assert.match(leave.body, /<form method="post"/);
    const late = await confirm(await linkToken("confirm"));
    assert.equal(late.headers.location, `${SITE.app}/crews`);
    assert.deepEqual(await reminders(), { email: "late@example.com", confirmed: false });
  });

  it("unsubscribes from the link in a mail, and the crew page shows no reminders", async () => {
    await remind({ email: "cy@example.com" });
    await confirm(await linkToken("confirm"));
    assert.deepEqual(await reminders(), { email: "cy@example.com", confirmed: true });
    const gone = await link(`/api/signups/unsubscribe?token=${await linkToken("unsubscribe")}`, "POST");
    assert.equal(gone.status, 200);
    assert.match(gone.body, /Du bist abgemeldet/);
    assert.deepEqual(await reminders(), { email: null, confirmed: false });
  });

  it("spends a confirm link: used again after an unsubscribe, it does nothing", async () => {
    await remind({ email: "ed@example.com" });
    const confirmToken = await linkToken("confirm");
    assert.equal((await confirm(confirmToken)).status, 303);
    const unsubscribeToken = await linkToken("unsubscribe");
    await link(`/api/signups/unsubscribe?token=${unsubscribeToken}`, "POST");
    const mails = (await outbox()).length;

    const again = await confirm(confirmToken);
    assert.equal(again.headers.location, `${SITE.app}/crews`);
    const [row] = await signupRows();
    assert.notEqual(row!.unsubscribed_at, null);
    assert.deepEqual(await reminders(), { email: null, confirmed: false });
    assert.equal((await outbox()).length, mails);
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

  it("off: the site's routes and its sign-up endpoint behave as before", async () => {
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
      // Reminders are the app's, for a signed-in player.
      assert.equal((await ask(HTTP, "/api/signups/reminders", { host: "app.lanterel.test" })).status, 401);
      assert.equal((await ask(HTTP, "/api/signups/reminders", { host: HOST })).status, 404);
    } finally {
      await stop();
    }
  });
});
