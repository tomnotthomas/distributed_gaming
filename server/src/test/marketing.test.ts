// The marketing site (marketing.ts) and its sign-ups (signups.ts). Most tests
// serve the real pages in web/marketing/ in-process, on a database of their
// own; the last start the real server with MARKETING_PAGES off and on.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Database } from "../db.js";
import type { InviteType } from "../invite-copy.js";
import {
  assetPath,
  createMarketing,
  inviteRoute,
  marketingFiles,
  pageRoutes,
  renderInvite,
  setText,
  siteFromEnv,
  type InviteResolver,
} from "../marketing.js";
import { migrate } from "../schema.js";
import {
  CLIENT_BURST,
  clientOf,
  createSignups,
  RESEND_AFTER_MS,
  signupInvite,
  type Signups,
} from "../signups.js";
import { testDatabase } from "./db.js";

const DIR = fileURLToPath(new URL("../../../web/marketing/", import.meta.url));
const SITE = { origin: "https://lanterel.test", host: "lanterel.test", app: "https://app.lanterel.test" };
const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const TYPES: InviteType[] = ["crew", "seat", "gift", "night"];
/** The example people and facts marketing built the invite pages with. */
const EXAMPLES =
  /\b(Max|Lena|Lenas|Lena's|Jonas|Jonas's|Tom|Toms|Tom's|Berlin|Freitag|Friday|Oktober|October)\b/;

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A request to `origin` as if for `host`, which fetch() cannot set. */
function ask(
  origin: string,
  path: string,
  { host = SITE.host, method = "GET", body = "", localAddress = "127.0.0.1" } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request(
      url,
      { method, localAddress, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } },
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
      "/en/share/": "en/share/index.html",
      "/host/": "host/index.html",
      "/impressum/": "impressum/index.html",
      "/lanterel-os/": "lanterel-os/index.html",
      "/share/": "share/index.html",
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

  it("reads an invite from a form as {type, code} or type:code, and nothing else", () => {
    assert.deepEqual(signupInvite({ type: "night", code: "AB12" }), { type: "night", code: "AB12" });
    // A crew invite's code may be the app's crew link token: only its type is kept.
    assert.deepEqual(signupInvite({ type: "crew", code: "AB12" }), { type: "crew", code: null });
    assert.deepEqual(signupInvite("crew:AB12"), { type: "crew", code: null });
    assert.deepEqual(signupInvite("seat:x_y-z"), { type: "seat", code: "x_y-z" });
    assert.equal(signupInvite(null), null);
    assert.equal(signupInvite("party:x"), null);
    assert.equal(signupInvite("crew:<b>"), null);
    assert.equal(signupInvite({ type: "crew", code: 7 }), null);
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
  let names: Map<string, string>;
  /** Whether the invite lookup fails, as a database error would make it. */
  let failLookup = false;

  /** The mails in the outbox, oldest first. */
  const outbox = async () =>
    (
      await db.query<{ to_address: string; template: string; subject: string; html: string; text: string }>(
        "SELECT to_address, template, subject, html, text FROM marketing_outbox ORDER BY created_at, id",
      )
    ).rows;

  /** Sign up, a second later than whatever came before. */
  async function signUp(body: Record<string, unknown>) {
    now += 1_000;
    return ask(origin, "/api/signups", { method: "POST", body: JSON.stringify(body) });
  }

  /** Press the button a confirm link's page has, a second later than whatever came before. */
  async function confirm(token: string) {
    now += 1_000;
    return ask(origin, `/api/signups/confirm?token=${token}`, { method: "POST" });
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
    const invites: InviteResolver = async (type, code) => {
      if (failLookup) throw new Error("the database is down");
      return { inviter: names.get(`${type}:${code}`) ?? null };
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await signups.serve(req, res, url)) return;
      const serve = createMarketing({ site: SITE, files, routes, invites, isShareCode: signups.isShareCode });
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
    names = new Map();
    signups = createSignups({ database: db, site: SITE, files: marketingFiles(DIR, SITE), now: () => now });
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

  it("takes sign-ups and their links only on the site's own host", async () => {
    const other = { host: "swiff.onrender.com" };
    const body = JSON.stringify({ email: "ana@example.com", kind: "player" });
    assert.equal((await ask(origin, "/api/signups", { ...other, method: "POST", body })).body, "the app");
    assert.equal((await ask(origin, "/api/signups/confirm?token=x", other)).body, "the app");
    assert.equal(
      (await ask(origin, "/api/signups/unsubscribe?token=x", { ...other, method: "POST" })).body,
      "the app",
    );
    assert.deepEqual(await signupRows(), []);
    assert.equal((await signUp({ email: "ana@example.com", kind: "player" })).status, 202);
  });

  it("lets one client send only a few sign-ups at a time, and not take the others' turn", async () => {
    /** Sign `email` up from `localAddress`, a client of its own. */
    const send = (email: string, localAddress = "127.0.0.1") =>
      ask(origin, "/api/signups", {
        method: "POST",
        body: JSON.stringify({ email, kind: "player" }),
        localAddress,
      });
    const sent = [];
    for (let i = 0; i < CLIENT_BURST + 2; i++) sent.push((await send(`a${i}@example.com`)).status);
    assert.deepEqual(sent, [...Array<number>(CLIENT_BURST).fill(202), 429, 429]);
    assert.equal((await send("b@example.com", "127.0.0.2")).status, 202);
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

  it("leaves every other host to the app", async () => {
    for (const path of ["/", "/en/", "/share/", "/host/", "/crew/AB12", "/assets/css/base.css"]) {
      assert.equal((await ask(origin, path, { host: "swiff.onrender.com" })).body, "the app", path);
    }
  });

  it("renders every invite template without the example people, its buttons carrying the code", async () => {
    for (const type of TYPES) {
      for (const lang of ["", "/en"]) {
        const path = `${lang}/${type}/AB12cd`;
        const page = await ask(origin, path);
        assert.equal(page.status, 200, path);
        assert.equal(page.headers["x-robots-tag"], "noindex");
        assert.match(page.body, /<meta name="robots" content="noindex">/);
        assert.doesNotMatch(page.body, EXAMPLES, path);
        assert.doesNotMatch(page.body, /\{\{|Swiff/, path);
        assert.match(page.body, /<title>[^<]+ \| Lanterel<\/title>/, path);
        if (type !== "night")
          assert.match(page.body, new RegExp(`\\?i=${type}:AB12cd#(bewerben|beta)"`), path);
        assert.doesNotMatch(page.body, /href="(\/en)?\/(host\/)?#(bewerben|beta)"/, path);
      }
    }
    // The template's own path, with no code: the same neutral page, its buttons as they were.
    const bare = await ask(origin, "/crew/");
    assert.equal(bare.status, 200);
    assert.doesNotMatch(bare.body, EXAMPLES);
    assert.match(bare.body, /href="\/host\/#bewerben"/);
    assert.equal((await ask(origin, "/crew/a.b")).body, "the app");
  });

  it("names a crew invite's inviter, escaped, where the product knows them", async () => {
    names.set("crew:AB12", "Ana");
    names.set("crew:EVIL", '<img src=x onerror="alert(1)">{{brand}}');
    const de = (await ask(origin, "/crew/AB12")).body;
    assert.match(de, /<title>Ana möchte bei dir zocken \| Lanterel<\/title>/);
    assert.match(de, /<h1 data-t="crew.h1" id="h1">Ana möchte <b>bei dir zocken.<\/b><\/h1>/);
    assert.match(de, /<meta property="og:title" content="Ana möchte bei dir zocken">/);
    assert.match(de, /<span class="av m">A<\/span>/);
    assert.match((await ask(origin, "/en/crew/AB12")).body, /<h1 data-t="crew.h1" id="h1">Ana wants to/);
    const evil = (await ask(origin, "/crew/EVIL")).body;
    assert.doesNotMatch(evil, /<img src=x/);
    assert.doesNotMatch(evil, /onerror="/);
    assert.match(evil, /&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62;&#123;&#123;brand&#125;&#125;/);
  });

  it("renders an invite from the template marketing built, whatever the code", () => {
    const template = '<a href="/host/#bewerben">x</a><a href="/en/#beta">y</a><a href="#zusage">z</a>';
    assert.equal(
      renderInvite(template, "gift", "en", "C0de", { inviter: null }),
      '<a href="/host/?i=gift:C0de#bewerben">x</a><a href="/en/?i=gift:C0de#beta">y</a><a href="#zusage">z</a>',
    );
  });

  it("still renders the invite page, naming nobody, when the invite lookup fails", async () => {
    names.set("crew:BOOM", "unused");
    failLookup = true;
    try {
      const page = await ask(origin, "/crew/BOOM");
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.body, EXAMPLES);
      assert.match(page.body, /<title>[^<]+ \| Lanterel<\/title>/);
    } finally {
      failLookup = false;
    }
  });

  it("names an inviter with $ patterns in it as they are", async () => {
    names.set("crew:CASH", "Ca$$h $& $' $`");
    const page = (await ask(origin, "/crew/CASH")).body;
    assert.match(page, /<title>Ca\$\$h \$&#38; \$&#39; \$` möchte bei dir zocken \| Lanterel<\/title>/);
    assert.match(page, /<b>Ca\$\$h \$&#38; \$&#39; \$`<\/b>/);
    assert.doesNotMatch(page, /<b>Max<\/b>|<title>[^<]*<b>/);
  });

  it("takes a waitlist sign-up with double opt-in, then hands out the player's crew link", async () => {
    const taken = await signUp({
      email: "  Ana@Example.COM ",
      kind: "player",
      lang: "de",
      page: "/crew/AB12",
      invite: { type: "crew", code: "AB12" },
    });
    assert.equal(taken.status, 202);
    assert.deepEqual(JSON.parse(taken.body), { ok: true });

    const [mail] = await outbox();
    assert.equal(mail!.to_address, "ana@example.com");
    assert.equal(mail!.template, "signup_confirm");
    assert.equal(mail!.subject, "Bitte bestätige deine Anmeldung");
    assert.match(mail!.text, /Danke für deine Anmeldung bei Lanterel/);
    assert.doesNotMatch(mail!.html + mail!.text, /\{\{|\{confirm_url\}|\{unsubscribe_url\}|Swiff/);
    assert.match(mail!.html, new RegExp(`href="${SITE.origin}/api/signups/confirm\\?token=[\\w-]+"`));

    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM marketing_signups");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.invite_type, "crew");
    assert.equal(rows[0]!.invite_code, null);
    assert.equal(rows[0]!.page, "/crew/");
    assert.doesNotMatch(JSON.stringify(rows[0]), /AB12/);
    assert.equal(rows[0]!.confirmed_at, null);
    const referral = rows[0]!.referral as string;

    // Not confirmed yet: the share page has no link of theirs.
    assert.match((await ask(origin, `/share/?code=${referral}`)).body, /\/crew\/<\/code>/);

    const confirmed = await confirm(await linkToken("confirm"));
    assert.equal(confirmed.status, 303);
    assert.equal(confirmed.headers.location, `${SITE.origin}/share/?code=${referral}`);

    const ask2 = (await outbox()).at(-1)!;
    assert.equal(ask2.template, "ask_pc_friend");
    assert.match(ask2.html, new RegExp(`href="${SITE.origin}/share/\\?code=${referral}"`));

    const share = await ask(origin, `/share/?code=${referral}`);
    assert.equal(share.headers["cache-control"], "private, no-store");
    assert.match(share.body, new RegExp(`<code id="lk">${SITE.origin}/crew/${referral}</code>`));
    assert.doesNotMatch(share.body, /DEINCODE|YOURCODE/);
    assert.match((await ask(origin, "/en/share/?code=nope")).body, new RegExp(`${SITE.origin}/crew/<`));

    // Again, confirmed: no new mail, nothing told.
    assert.equal((await signUp({ email: "ana@example.com", kind: "player" })).status, 202);
    assert.equal((await outbox()).length, 2);
    // Confirming twice sends the friend mail once.
    assert.equal((await outbox()).filter((m) => m.template === "ask_pc_friend").length, 1);
  });

  it("sends the confirm mail again only after a while, keeping the first invite", async () => {
    await signUp({ email: "bo@example.com", kind: "player", lang: "en", invite: "gift:G1" });
    await signUp({ email: "bo@example.com", kind: "player", lang: "en", invite: "seat:S1" });
    assert.equal((await outbox()).length, 1);
    now += RESEND_AFTER_MS;
    await signUp({ email: "bo@example.com", kind: "player", lang: "en" });
    const mails = await outbox();
    assert.equal(mails.length, 2);
    assert.equal(mails[1]!.subject, "Please confirm your email");
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT invite_type, invite_code FROM marketing_signups",
    );
    assert.deepEqual(rows[0], { invite_type: "gift", invite_code: "G1" });
  });

  it("takes a Founding Host application with the invite it came with", async () => {
    const taken = await signUp({ email: "host@example.com", kind: "host", lang: "en", invite: "crew:AB12" });
    assert.equal(taken.status, 202);
    const confirmed = await confirm(await linkToken("confirm"));
    assert.equal(confirmed.headers.location, `${SITE.origin}/en/host/`);
    assert.deepEqual(
      (await outbox()).map((m) => m.template),
      ["signup_confirm"],
    );
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT kind, invite_code FROM marketing_signups",
    );
    assert.deepEqual(rows[0], { kind: "host", invite_code: null });
  });

  it("keeps a crew invite's type, never its code, also when a resend comes with another invite", async () => {
    await signUp({
      email: "cy@example.com",
      kind: "player",
      page: "/en/crew/CREWTOKEN",
      invite: "crew:CREWTOKEN",
    });
    now += RESEND_AFTER_MS;
    await signUp({ email: "cy@example.com", kind: "player", invite: "seat:S1" });
    assert.equal((await outbox()).length, 2);
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT invite_type, invite_code FROM marketing_signups",
    );
    assert.deepEqual(rows[0], { invite_type: "crew", invite_code: null });
    assert.doesNotMatch(JSON.stringify(await signupRows()), /CREWTOKEN/);

    await signUp({ email: "di@example.com", kind: "player" });
    now += RESEND_AFTER_MS;
    await signUp({ email: "di@example.com", kind: "player", invite: { type: "crew", code: "CREWTOKEN" } });
    const later = await db.query<Record<string, unknown>>(
      "SELECT invite_type, invite_code FROM marketing_signups WHERE email = 'di@example.com'",
    );
    assert.deepEqual(later.rows[0], { invite_type: "crew", invite_code: null });
  });

  it("refuses what is not a sign-up and lands a bad link on the site", async () => {
    assert.equal((await signUp({ email: "nope", kind: "player" })).status, 400);
    assert.equal((await signUp({ email: `${"a".repeat(250)}@x.de`, kind: "player" })).status, 400);
    assert.equal((await signUp({ email: "a@b.de", kind: "admin" })).status, 400);
    assert.equal((await ask(origin, "/api/signups", { method: "POST", body: "[" })).status, 400);
    assert.equal((await outbox()).length, 0);
    const bad = await confirm("forged");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, `${SITE.origin}/`);
    assert.equal(
      (await ask(origin, "/api/signups/unsubscribe?token=forged", { method: "POST" })).status,
      404,
    );
    // A link nobody knows says so in both languages, with nothing to press.
    for (const action of ["confirm", "unsubscribe"]) {
      const unknown = await ask(origin, `/api/signups/${action}?token=%22%3E%3Cscript%3E`);
      assert.equal(unknown.status, 404);
      assert.match(unknown.body, /Dieser Link ist ungültig. · This link is not valid./);
      assert.doesNotMatch(unknown.body, /<form|<button|<script>/);
    }
  });

  it("only asks on a link's GET, which mail scanners open too: nothing changes", async () => {
    await signUp({ email: "dee@example.com", kind: "player", lang: "en" });
    const confirmToken = await linkToken("confirm");
    const unsubscribeToken = await linkToken("unsubscribe");
    const before = await signupRows();

    const asked = await ask(origin, `/api/signups/confirm?token=${confirmToken}`);
    assert.equal(asked.status, 200);
    assert.equal(asked.headers["cache-control"], "no-store");
    assert.match(asked.body, /<a class="wordmark" href="https:\/\/lanterel.test\/">LANTEREL<\/a>/);
    assert.match(asked.body, new RegExp(`<link rel="stylesheet" href="${SITE.origin}/assets/css/base.css">`));
    assert.match(
      asked.body,
      new RegExp(
        `<form method="post" action="/api/signups/confirm\\?token=${confirmToken}"><button[^>]*>Confirm</button>`,
      ),
    );
    assert.doesNotMatch(asked.body, /Bestätigen/);
    const leave = await ask(origin, `/api/signups/unsubscribe?token=${unsubscribeToken}`);
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
    await signUp({ email: "late@example.com", kind: "player" });
    now += 8 * 24 * 60 * 60_000;
    // Its page says it is not valid, with nothing to press; the unsubscribe link still works.
    const asked = await ask(origin, `/api/signups/confirm?token=${await linkToken("confirm")}`);
    assert.equal(asked.status, 404);
    assert.match(asked.body, /Dieser Link ist ungültig. · This link is not valid./);
    assert.doesNotMatch(asked.body, /<form|<button/);
    const leave = await ask(origin, `/api/signups/unsubscribe?token=${await linkToken("unsubscribe")}`);
    assert.equal(leave.status, 200);
    assert.match(leave.body, /<form method="post"/);
    const late = await confirm(await linkToken("confirm"));
    assert.equal(late.headers.location, `${SITE.origin}/`);
  });

  it("unsubscribes from the link in a mail, and the crew link stops showing", async () => {
    await signUp({ email: "cy@example.com", kind: "player" });
    await confirm(await linkToken("confirm"));
    const { rows } = await db.query<{ referral: string }>("SELECT referral FROM marketing_signups");
    assert.equal(await signups.isShareCode(rows[0]!.referral), true);
    const gone = await ask(origin, `/api/signups/unsubscribe?token=${await linkToken("unsubscribe")}`, {
      method: "POST",
    });
    assert.equal(gone.status, 200);
    assert.match(gone.body, /Du bist abgemeldet/);
    assert.equal(await signups.isShareCode(rows[0]!.referral), false);
  });

  it("spends a confirm link: used again after an unsubscribe, it does nothing", async () => {
    await signUp({ email: "ed@example.com", kind: "player" });
    const confirmToken = await linkToken("confirm");
    assert.equal((await confirm(confirmToken)).status, 303);
    const unsubscribeToken = await linkToken("unsubscribe");
    await ask(origin, `/api/signups/unsubscribe?token=${unsubscribeToken}`, { method: "POST" });
    const mails = (await outbox()).length;

    const again = await confirm(confirmToken);
    assert.equal(again.headers.location, `${SITE.origin}/`);
    const [row] = await signupRows();
    assert.notEqual(row!.unsubscribed_at, null);
    assert.equal(await signups.isShareCode(row!.referral as string), false);
    assert.equal((await outbox()).length, mails);
  });
});

describe("MARKETING_PAGES on the real server", () => {
  const PORT = 10_300 + Math.floor(Math.random() * 300);
  const HTTP = `http://127.0.0.1:${PORT}`;
  const HOST = `lanterel.localhost:${PORT}`;
  let server: ChildProcess | null = null;

  /** Start the real server with `env` and wait until it answers. */
  async function start(env: Record<string, string>) {
    // The port is free again only once the last server has exited.
    await stop();
    server = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), SWIFF_PLAYABILITY: "off", DATABASE_URL: "", ...env },
      stdio: "ignore",
    });
    const child = server;
    // A loaded machine can take a while to boot the server; a child that dies
    // fails the test at once instead of waiting out the deadline.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before answering: code ${child.exitCode}, signal ${child.signalCode}`);
      }
      try {
        await fetch(`${HTTP}/api/ping`, { signal: AbortSignal.timeout(5_000) });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server did not answer /api/ping within 60s");
  }

  /** Stop the server started last, and wait until it has exited. */
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server!.once("exit", resolve));
      server.kill();
      await exited;
    }
    server = null;
  }

  after(stop);

  it("off: the site's routes and its sign-up endpoint behave as before", async () => {
    await start({ SITE_ORIGIN: `http://${HOST}` });
    try {
      for (const path of ["/", "/host/", "/crew/AB12", "/robots.txt"]) {
        const page = await ask(HTTP, path, { host: HOST });
        assert.doesNotMatch(page.body, /form-endpoint|Lanterel/, path);
        assert.equal(page.body, (await ask(HTTP, path, { host: `127.0.0.1:${PORT}` })).body, path);
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
      assert.match(landing.body, /<meta name="form-endpoint" content="\/api\/signups">/);
      assert.match(landing.body, new RegExp(`<link rel="canonical" href="http://${HOST}/">`));
      assert.doesNotMatch((await ask(HTTP, "/", { host: `127.0.0.1:${PORT}` })).body, /form-endpoint/);
      const invite = await ask(HTTP, "/en/crew/AB12", { host: HOST });
      assert.match(invite.body, /A friend wants to <b>borrow your rig.<\/b>/);
      const posted = await ask(HTTP, "/api/signups", {
        host: HOST,
        method: "POST",
        body: JSON.stringify({
          email: "a@b.de",
          kind: "player",
          lang: "de",
          invite: { type: "crew", code: "AB12" },
        }),
      });
      assert.equal(posted.status, 202);
    } finally {
      await stop();
    }
  });
});
