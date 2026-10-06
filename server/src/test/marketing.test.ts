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
import { createSignups, RESEND_AFTER_MS, signupInvite, type Signups } from "../signups.js";
import { testDatabase } from "./db.js";

const DIR = fileURLToPath(new URL("../../../web/marketing/", import.meta.url));
const SITE = { origin: "https://lanterel.test", host: "lanterel.test" };
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
  { host = SITE.host, method = "GET", body = "" } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request(
      url,
      { method, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } },
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

describe("marketing configuration", () => {
  it("is off unless MARKETING_PAGES=on, and on only with a usable SITE_ORIGIN", () => {
    assert.equal(siteFromEnv({}), null);
    assert.equal(siteFromEnv({ SITE_ORIGIN: "https://lanterel.de" }), null);
    assert.equal(siteFromEnv({ MARKETING_PAGES: "on" }), null);
    assert.equal(siteFromEnv({ MARKETING_PAGES: "on", SITE_ORIGIN: "ftp://lanterel.de" }), null);
    assert.deepEqual(siteFromEnv({ MARKETING_PAGES: "on", SITE_ORIGIN: "https://lanterel.de/x" }), {
      origin: "https://lanterel.de",
      host: "lanterel.de",
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
    assert.deepEqual(signupInvite({ type: "crew", code: "AB12" }), { type: "crew", code: "AB12" });
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

  /** Follow a confirm link, a second later than whatever came before. */
  async function confirm(token: string) {
    now += 1_000;
    return ask(origin, `/api/signups/confirm?token=${token}`);
  }

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
    const invites: InviteResolver = async (type, code) => ({ inviter: names.get(`${type}:${code}`) ?? null });
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
    }
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
    assert.equal(rows[0]!.invite_code, "AB12");
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
    assert.deepEqual(rows[0], { kind: "host", invite_code: "AB12" });
  });

  it("refuses what is not a sign-up and lands a bad link on the site", async () => {
    assert.equal((await signUp({ email: "nope", kind: "player" })).status, 400);
    assert.equal((await signUp({ email: `${"a".repeat(250)}@x.de`, kind: "player" })).status, 400);
    assert.equal((await signUp({ email: "a@b.de", kind: "admin" })).status, 400);
    assert.equal((await ask(origin, "/api/signups", { method: "POST", body: "[" })).status, 400);
    assert.equal((await outbox()).length, 0);
    const bad = await ask(origin, "/api/signups/confirm?token=forged");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, `${SITE.origin}/`);
    assert.equal((await ask(origin, "/api/signups/unsubscribe?token=forged")).status, 404);
  });

  it("does not confirm with a link a week old", async () => {
    await signUp({ email: "late@example.com", kind: "player" });
    now += 8 * 24 * 60 * 60_000;
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
});

describe("MARKETING_PAGES on the real server", () => {
  const PORT = 10_300 + Math.floor(Math.random() * 300);
  const HTTP = `http://127.0.0.1:${PORT}`;
  const HOST = `lanterel.localhost:${PORT}`;
  let server: ChildProcess | null = null;

  async function start(env: Record<string, string>) {
    server = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), SWIFF_PLAYABILITY: "off", DATABASE_URL: "", ...env },
      stdio: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try {
        await fetch(`${HTTP}/api/ping`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("server did not start");
  }

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
    await start({ MARKETING_PAGES: "on", SITE_ORIGIN: `http://${HOST}` });
    try {
      const landing = await ask(HTTP, "/", { host: HOST });
      assert.equal(landing.status, 200);
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
