// Reminders by email, the one address the product ever asks for: optional,
// on the app's crew page, for a player signed in with Steam (their session
// cookie, signin.ts), so they hear when their crew plays. Signing up itself is
// signing in with Steam and needs no email. Double opt-in: nothing goes to an
// address until it confirms. Served with the marketing site, whose launch set
// holds the mails (emails/signup_confirm), so only while MARKETING_PAGES=on,
// and only on the app's host, where the crew page and the session are.
//
//   GET  /api/signups/reminders          the player's reminders: {email, confirmed}
//   POST /api/signups/reminders          {email, lang}: send them there, once confirmed
//   POST /api/signups/reminders/off      stop them
//   GET  /api/signups/confirm?token=     the link in signup_confirm: a page with a button
//   POST /api/signups/confirm?token=     that button: confirms, then back to the crew page
//   GET  /api/signups/unsubscribe?token= the link in every mail: a page with a button
//   POST /api/signups/unsubscribe?token= that button (and one-click): unsubscribes
//
// Nothing changes on a GET: mail scanners open every link in a mail, and only
// a click on the button proves a person did. A player keeps one address; a
// new one needs confirming again. Each address a player gives gets one
// confirm mail a while; one held back says when to ask again. Each client may
// send a few at a time.
//
// The server has no way to send mail yet, so every mail is rendered into
// marketing_outbox and stays there.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BRAND, WORDMARK } from "./brand.js";
import type { Database, Queryable } from "./db.js";
import { HttpError, readJson } from "./http.js";
import type { Lang } from "./invite-copy.js";
import type { MarketingFiles, Site } from "./marketing.js";
import { RequestBudget } from "./budget.js";

/** A reminders body: an address and a language. */
const MAX_SIGNUP_BODY_BYTES = 4 * 1024;
/** RFC 5321's limit on a forward path. */
const MAX_EMAIL_LENGTH = 254;
/** The same check the crew page makes, so nothing it lets through is refused here. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A player gets another confirm mail to the same address no sooner than this. */
export const RESEND_AFTER_MS = 60 * 60_000;
/** A confirm link works for this long after its mail. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * Requests one client may send at once, then one more every CLIENT_REFILL_MS:
 * a household or an office behind one address, with retries.
 */
export const CLIENT_BURST = 10;
const CLIENT_REFILL_MS = 6_000;
/** Requests the whole server takes at once, then one more every SIGNUP_REFILL_MS: a flood of many clients. */
const SIGNUP_BURST = 120;
const SIGNUP_REFILL_MS = 500;

/**
 * Who sent a request, for its budget: the address that connected, or,
 * behind a proxy the deployment trusts (`trustProxy`), the address that proxy
 * appended last to X-Forwarded-For. A client can put anything it likes before
 * that, never after it.
 */
export function clientOf(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").at(-1)?.trim();
  return (trustProxy && last) || req.socket.remoteAddress || "unknown";
}

type Json = Record<string, unknown>;

const LINK_ACTIONS = ["confirm", "unsubscribe"] as const;
type LinkAction = (typeof LINK_ACTIONS)[number];

/** A link page's words in one language. */
type Copy = { title: string; text: string; button?: string };

/** What the page a mail's link opens asks for. */
const ASK: Record<LinkAction, Record<Lang, Copy>> = {
  confirm: {
    de: {
      title: "Erinnerungen bestätigen",
      text: "Ein Klick, dann erinnern wir dich an eure Zockrunden.",
      button: "Bestätigen",
    },
    en: {
      title: "Confirm your reminders",
      text: "One click and we'll remind you of your gaming sessions.",
      button: "Confirm",
    },
  },
  unsubscribe: {
    de: { title: "Abmelden", text: "Danach schicken wir dir keine Mails mehr.", button: "Abmelden" },
    en: { title: "Unsubscribe", text: "We won't email you again after this.", button: "Unsubscribe" },
  },
};

const UNSUBSCRIBED: Record<Lang, Copy> = {
  de: { title: "Abgemeldet", text: "Du bist abgemeldet. Wir schicken dir keine Mails mehr." },
  en: { title: "Unsubscribed", text: "You're unsubscribed. We won't email you again." },
};

const INVALID: Record<Lang, Copy> = {
  de: { title: "Ungültiger Link", text: "Dieser Link ist ungültig." },
  en: { title: "Invalid link", text: "This link is not valid." },
};

/** A new confirm or unsubscribe token: 24 random bytes. */
const token = () => randomBytes(24).toString("base64url");
/** A token as kept: its SHA-256, in hex. */
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** A new row id. */
const newId = () => randomBytes(16).toString("base64url");

/** The address as kept: trimmed and lower-cased; null when it is not one. */
export function signupEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
}

/** One rendered mail. */
export type Mail = { to: string; template: string; subject: string; html: string; text: string };

/**
 * Render emails/`template`.`lang` with `values` for its {placeholders}. The
 * subject is the text version's first line ("Subject: …"). Null when the
 * template is missing.
 */
export async function renderMail(
  files: MarketingFiles,
  template: string,
  lang: Lang,
  to: string,
  values: Record<string, string>,
): Promise<Mail | null> {
  const [html, text] = await Promise.all([
    files.text(`emails/${template}.${lang}.html`),
    files.text(`emails/${template}.${lang}.txt`),
  ]);
  if (html === null || text === null) return null;
  /** `s` safe as HTML text, for a placeholder filled into a mail's HTML version. */
  const escapeHtml = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  /** `s` with each {placeholder} it has a value for replaced by that value, escaped with `escape`. */
  const fill = (s: string, escape: (v: string) => string) =>
    s.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? escape(values[key]!) : whole));
  const [first, ...rest] = text.split("\n");
  const subject = /^Subject:\s*(.*)$/.exec(first ?? "")?.[1]?.trim();
  return {
    to,
    template,
    subject: subject ?? BRAND,
    html: fill(html, escapeHtml),
    text: fill(subject ? rest.join("\n").replace(/^\n/, "") : text, (v) => v),
  };
}

/** Keep `mail` in the outbox. */
async function enqueue(db: Queryable, mail: Mail, now: number): Promise<void> {
  await db.query(
    `INSERT INTO marketing_outbox (id, to_address, template, subject, html, text, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), mail.to, mail.template, mail.subject, mail.html, mail.text, now],
  );
}

export type SignupsOptions = {
  database: Database;
  site: Site;
  files: MarketingFiles;
  /** The signed-in player's Steam id from a request's session cookie (signin.ts renterOf); null: signed out. */
  renter: (req: IncomingMessage) => string | null;
  now?: () => number;
  /** Requests the server takes in all; defaults to SIGNUP_BURST at once. */
  budget?: RequestBudget;
  /** Requests each client may send; defaults to CLIENT_BURST at once. */
  perClient?: RequestBudget;
  /** Whether a proxy in front of the server appends the client's address to X-Forwarded-For (Render does). */
  trustProxy?: boolean;
};

type ReminderRow = {
  id: string;
  unsubscribe: string;
  email: string;
  lang: Lang;
  confirm_sent_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
};

/**
 * A player's reminders as the crew page shows them: the address they go to,
 * whether it confirmed, and, when its confirm mail was held back, when to ask again.
 */
export type Reminders = { email: string | null; confirmed: boolean; retryAt?: number };

/**
 * The reminders of the app's players on `database`, with their mails
 * rendered from `files` into the outbox: what serves their routes (`serve`).
 */
export function createSignups({
  database,
  site,
  files,
  renter,
  now = Date.now,
  budget = new RequestBudget({ burst: SIGNUP_BURST, refillMs: SIGNUP_REFILL_MS }),
  perClient = new RequestBudget({ burst: CLIENT_BURST, refillMs: CLIENT_REFILL_MS }),
  trustProxy = false,
}: SignupsOptions) {
  const appHost = new URL(site.app).host.toLowerCase();
  /** The app's crew pages, where a confirmed or unknown link lands. */
  const crewPage = `${site.app}/crews`;
  /** A mail's link to `action` (confirm or unsubscribe) with its token. */
  const linkUrl = (action: string, value: string) =>
    `${site.app}/api/signups/${action}?token=${encodeURIComponent(value)}`;

  /** Queue the confirm mail for an address with a fresh confirm token. */
  async function sendConfirm(
    tx: Queryable,
    row: Pick<ReminderRow, "email" | "lang" | "unsubscribe">,
    confirm: string,
  ) {
    const mail = await renderMail(files, "signup_confirm", row.lang, row.email, {
      confirm_url: linkUrl("confirm", confirm),
      unsubscribe_url: linkUrl("unsubscribe", row.unsubscribe),
    });
    if (mail) await enqueue(tx, mail, now());
  }

  /** `steamId`'s reminders as they stand. */
  async function reminders(steamId: string): Promise<Reminders> {
    const { rows } = await database.query<ReminderRow>(
      `SELECT * FROM marketing_signups WHERE steam_id = $1 AND unsubscribed_at IS NULL`,
      [steamId],
    );
    const row = rows[0];
    return { email: row?.email ?? null, confirmed: row?.confirmed_at != null };
  }

  /**
   * Send `steamId`'s reminders to `body.email` once that address confirms. A
   * new address, or one stopped, starts over, unconfirmed; a new one with its
   * own unsubscribe link. The same one, confirmed, needs nothing. An address
   * gets its next confirm mail only RESEND_AFTER_MS after its last one: until
   * then, when to ask again.
   */
  async function remind(steamId: string, body: Json): Promise<number | null> {
    const email = signupEmail(body.email);
    if (!email) throw new HttpError(400, "email is not an email address");
    const lang: Lang = body.lang === "en" ? "en" : "de";
    const at = now();
    const confirm = token();
    const address = hash(email);
    return database.transaction(async (tx) => {
      const { rows } = await tx.query<ReminderRow>(
        `SELECT * FROM marketing_signups WHERE steam_id = $1 FOR UPDATE`,
        [steamId],
      );
      const known = rows[0];
      await tx.query(`DELETE FROM marketing_confirm_sends WHERE sent_at <= $1`, [at - RESEND_AFTER_MS]);
      const last = await tx.query<{ sent_at: number }>(
        `SELECT sent_at FROM marketing_confirm_sends WHERE steam_id = $1 AND email_hash = $2`,
        [steamId, address],
      );
      const retryAt = last.rows[0] ? last.rows[0].sent_at + RESEND_AFTER_MS : null;
      /** Queue the confirm mail and keep when it went to this address. */
      const mail = async (unsubscribe: string) => {
        await sendConfirm(tx, { email, lang, unsubscribe }, confirm);
        await tx.query(
          `INSERT INTO marketing_confirm_sends (steam_id, email_hash, sent_at) VALUES ($1, $2, $3)
           ON CONFLICT (steam_id, email_hash) DO UPDATE SET sent_at = $3`,
          [steamId, address, at],
        );
      };
      if (!known) {
        const unsubscribe = token();
        // Another request for the same player may have just made it: then that one mails.
        const made = await tx.query(
          `INSERT INTO marketing_signups (id, email, kind, steam_id, lang, referral, confirm_hash,
             unsubscribe, created_at, confirm_sent_at)
           VALUES ($1, $2, 'reminders', $3, $4, $5, $6, $7, $8, $8)
           ON CONFLICT (steam_id) DO NOTHING`,
          [newId(), email, steamId, lang, newId(), hash(confirm), unsubscribe, at],
        );
        if (made.rowCount) await mail(unsubscribe);
        return null;
      }
      const asked = known.email === email && known.unsubscribed_at === null;
      if (asked && known.confirmed_at !== null) return null;
      // Still waiting for the link it was mailed, which works.
      if (asked && retryAt !== null) return retryAt;
      // Starting over: nothing goes to it until it confirms, and no link mailed before
      // works for it. Held back, it waits with a confirm link nobody holds.
      const unsubscribe = known.email === email ? known.unsubscribe : token();
      await tx.query(
        `UPDATE marketing_signups SET email = $2, lang = $3, confirm_hash = $4, confirm_sent_at = $5,
           unsubscribe = $6, confirmed_at = NULL, unsubscribed_at = NULL
         WHERE id = $1`,
        [known.id, email, lang, hash(retryAt === null ? confirm : token()), at, unsubscribe],
      );
      if (retryAt === null) await mail(unsubscribe);
      return retryAt;
    });
  }

  /** Stop `steamId`'s reminders. */
  async function stop(steamId: string): Promise<void> {
    await database.query(
      `UPDATE marketing_signups SET unsubscribed_at = coalesce(unsubscribed_at, $2) WHERE steam_id = $1`,
      [steamId, now()],
    );
  }

  /**
   * Confirm the address `value` was sent for; false for a link that is
   * unknown, too old or already used. The link is spent: its hash is replaced
   * by one nobody holds.
   */
  async function confirm(value: string): Promise<boolean> {
    const at = now();
    return database.transaction(async (tx) => {
      const { rows } = await tx.query<ReminderRow>(
        `SELECT * FROM marketing_signups WHERE confirm_hash = $1 FOR UPDATE`,
        [hash(value)],
      );
      const row = rows[0];
      if (!row || at - row.confirm_sent_at > CONFIRM_TTL_MS) return false;
      await tx.query(
        `UPDATE marketing_signups SET confirmed_at = $2, unsubscribed_at = NULL, confirm_hash = $3
         WHERE id = $1`,
        [row.id, at, hash(token())],
      );
      return true;
    });
  }

  /** Stop the reminders `value` was sent for; their language, or null for an unknown link. */
  async function unsubscribe(value: string): Promise<Lang | null> {
    const { rows } = await database.query<{ lang: Lang }>(
      `UPDATE marketing_signups SET unsubscribed_at = coalesce(unsubscribed_at, $2)
       WHERE unsubscribe = $1 RETURNING lang`,
      [value, now()],
    );
    return rows[0]?.lang ?? null;
  }

  /** The language of the address a confirm or unsubscribe link is for, or null for an unknown or expired one. */
  async function linkLang(action: LinkAction, value: string): Promise<Lang | null> {
    const { rows } =
      action === "confirm"
        ? await database.query<{ lang: Lang }>(
            `SELECT lang FROM marketing_signups WHERE confirm_hash = $1 AND confirm_sent_at >= $2`,
            [hash(value), now() - CONFIRM_TTL_MS],
          )
        : await database.query<{ lang: Lang }>(`SELECT lang FROM marketing_signups WHERE unsubscribe = $1`, [
            value,
          ]);
    return rows[0]?.lang ?? null;
  }

  /** Answer `body` as JSON, never kept by a cache. */
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  /** A small page on the site's look, in `lang`, or in both for an unknown link. */
  function page(res: ServerResponse, status: number, lang: Lang | null, copy: Record<Lang, Copy>, form = "") {
    /** A line in the link's language, or in German and English for a link nobody knows. */
    const both = (pick: (c: Copy) => string) =>
      lang ? pick(copy[lang]) : `${pick(copy.de)} · ${pick(copy.en)}`;
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    });
    res.end(
      `<!doctype html><html lang="${lang ?? "de"}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="robots" content="noindex"><title>${both((c) => c.title)} | ${BRAND}</title>` +
        `<link rel="stylesheet" href="${site.origin}/assets/css/fonts.css">` +
        `<link rel="stylesheet" href="${site.origin}/assets/css/base.css">` +
        `<link rel="stylesheet" href="${site.origin}/assets/css/legal.css"></head>` +
        `<body class="legal"><header class="lg-nav"><a class="wordmark" href="${crewPage}">${WORDMARK}</a></header>` +
        `<main class="lg-main"><h1>${both((c) => c.title)}</h1><p class="lead">${both((c) => c.text)}</p>` +
        (form &&
          `<form method="post" action="${form}"><button class="copy" type="submit">${both((c) => c.button ?? "")}</button></form>`) +
        `</main></body></html>`,
    );
  }

  /** Answer 429 when this client, or every client together, has sent all it may for now; false while they may send more. */
  function overBudget(req: IncomingMessage, res: ServerResponse): boolean {
    // Each client's own budget first, so one client sending many runs out alone; the server's in all
    // only stops a flood from many at once.
    const waitMs = perClient.take(clientOf(req, trustProxy)) || budget.take("signups");
    if (waitMs <= 0) return false;
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(Math.ceil(waitMs / 1000)),
    });
    res.end(JSON.stringify({ error: "too many requests right now; try again" }));
    return true;
  }

  /** Serve a request under /api/signups; false for a path or method it does not know. */
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (path === "/api/signups/reminders" || path === "/api/signups/reminders/off") {
      const steamId = renter(req);
      if (!steamId) throw new HttpError(401, "sign in with Steam first");
      if (path === "/api/signups/reminders" && method === "GET") {
        json(res, 200, await reminders(steamId));
        return true;
      }
      if (method !== "POST") return false;
      if (overBudget(req, res)) return true;
      if (path === "/api/signups/reminders/off") {
        await stop(steamId);
        json(res, 200, await reminders(steamId));
        return true;
      }
      const retryAt = await remind(steamId, await readJson(req, MAX_SIGNUP_BODY_BYTES));
      json(res, 200, retryAt === null ? await reminders(steamId) : { ...(await reminders(steamId)), retryAt });
      return true;
    }
    const action = LINK_ACTIONS.find((a) => path === `/api/signups/${a}`);
    if (!action) return false;
    const value = url.searchParams.get("token") ?? "";
    if (method === "GET") {
      // An unknown, old or used link offers nothing to press.
      const lang = value ? await linkLang(action, value) : null;
      if (lang)
        page(res, 200, lang, ASK[action], `/api/signups/${action}?token=${encodeURIComponent(value)}`);
      else page(res, 404, null, INVALID);
      return true;
    }
    if (method !== "POST") return false;
    if (action === "confirm") {
      const confirmed = value ? await confirm(value) : false;
      // An unknown, old or used link still lands on the crew page, which offers asking again.
      res
        .writeHead(303, {
          location: confirmed ? `${crewPage}#reminders=on` : crewPage,
          "cache-control": "no-store",
        })
        .end();
      return true;
    }
    const lang = value ? await unsubscribe(value) : null;
    page(res, lang ? 200 : 404, lang, lang ? UNSUBSCRIBED : INVALID);
    return true;
  }

  return {
    /** Serve a reminders request; false for any other. */
    async serve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith("/api/signups")) return false;
      // Only on the app's own host, where the crew page and its session are, and its mail links point.
      if (req.headers.host?.toLowerCase() !== appHost) return false;
      try {
        return await route(req, res, url);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        // Never the address or the body: only what kind of failure it was.
        if (status === 500)
          console.error("[swiff] reminders failed:", error instanceof Error ? error.name : typeof error);
        json(res, status, { error: status === 500 ? "internal error" : (error as Error).message });
        return true;
      }
    },
  };
}

export type Signups = ReturnType<typeof createSignups>;
