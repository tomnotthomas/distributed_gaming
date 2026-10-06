// Sign-ups from the marketing site (marketing.ts): the waitlist and the
// Founding Host application, with double opt-in. Served with the site, so only
// while MARKETING_PAGES=on, and only on the site's host, where its forms post
// and its mail links point. Each client may send a few at a time.
//
//   POST /api/signups               {email, kind: "player" | "host", lang, page, invite}
//   GET  /api/signups/confirm?token=     the link in signup_confirm: a page with a button
//   POST /api/signups/confirm?token=     that button: confirms
//   GET  /api/signups/unsubscribe?token= the link in every mail: a page with a button
//   POST /api/signups/unsubscribe?token= that button (and one-click): unsubscribes
//
// Nothing changes on a GET: mail scanners open every link in a mail, and only
// a click on the button proves a person did. A sign-up is kept per address and
// kind, unconfirmed, and gets the confirm mail (emails/signup_confirm).
// Confirming it puts it on the list and spends its confirm link; a player
// then gets their own crew link (/crew/<referral>) in emails/ask_pc_friend and
// on the share page. The invite a form came with (`invite`, {type, code} from
// an invite page's path or "type:code" from its ?i=) is kept with the sign-up.
// The answer to a sign-up never says whether the address was known.
//
// The server has no way to send mail yet, so every mail is rendered into
// marketing_outbox and stays there.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BRAND, WORDMARK } from "./brand.js";
import type { Database, Queryable } from "./db.js";
import { HttpError, readJson } from "./http.js";
import type { Lang } from "./invite-copy.js";
import { INVITE_CODE, INVITE_TYPES, type MarketingFiles, type Site } from "./marketing.js";
import { RequestBudget } from "./budget.js";

/** A sign-up form's body: an address and a few short fields. */
const MAX_SIGNUP_BODY_BYTES = 4 * 1024;
/** RFC 5321's limit on a forward path. */
const MAX_EMAIL_LENGTH = 254;
const MAX_PAGE_LENGTH = 200;
/** The same check the pages make, so nothing they let through is refused here. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** An unconfirmed sign-up gets another confirm mail no sooner than this. */
export const RESEND_AFTER_MS = 60 * 60_000;
/** A confirm link works for this long after its mail. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * Sign-ups one client may send at once, then one more every CLIENT_REFILL_MS:
 * a household or an office behind one address signing up, with retries.
 */
export const CLIENT_BURST = 10;
const CLIENT_REFILL_MS = 6_000;
/** Sign-ups the whole server takes at once, then one more every SIGNUP_REFILL_MS: a flood of many clients. */
const SIGNUP_BURST = 120;
const SIGNUP_REFILL_MS = 500;

/**
 * Who sent a request, for its sign-up budget: the address that connected,
 * or, behind a proxy the deployment trusts (`trustProxy`), the address that
 * proxy appended last to X-Forwarded-For. A client can put anything it likes
 * before that, never after it.
 */
export function clientOf(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").at(-1)?.trim();
  return (trustProxy && last) || req.socket.remoteAddress || "unknown";
}

export type Kind = "player" | "host";
export type Invite = { type: string; code: string };

type Json = Record<string, unknown>;

const LINK_ACTIONS = ["confirm", "unsubscribe"] as const;
type LinkAction = (typeof LINK_ACTIONS)[number];

/** A link page's words in one language. */
type Copy = { title: string; text: string; button?: string };

/** What the page a mail's link opens asks for. */
const ASK: Record<LinkAction, Record<Lang, Copy>> = {
  confirm: {
    de: { title: "Anmeldung bestätigen", text: "Ein Klick, und du bist dabei.", button: "Bestätigen" },
    en: { title: "Confirm your sign-up", text: "One click and you're in.", button: "Confirm" },
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
/** A crew link code: 8 characters, which INVITE_CODE accepts. */
const referralCode = () => randomBytes(6).toString("base64url");

/** The address as kept: trimmed and lower-cased; null when it is not one. */
export function signupEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
}

/** The invite a form sent, {type, code} or "type:code"; null for none or anything else. */
export function signupInvite(value: unknown): Invite | null {
  let type: unknown;
  let code: unknown;
  if (typeof value === "string") [type, code] = value.split(":", 2);
  else if (value && typeof value === "object") ({ type, code } = value as Json);
  if (typeof type !== "string" || typeof code !== "string") return null;
  return (INVITE_TYPES as readonly string[]).includes(type) && INVITE_CODE.test(code) ? { type, code } : null;
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
  now?: () => number;
  /** Sign-ups the server takes in all; defaults to SIGNUP_BURST at once. */
  budget?: RequestBudget;
  /** Sign-ups each client may send; defaults to CLIENT_BURST at once. */
  perClient?: RequestBudget;
  /** Whether a proxy in front of the server appends the client's address to X-Forwarded-For (Render does). */
  trustProxy?: boolean;
};

type SignupRow = {
  id: string;
  unsubscribe: string;
  email: string;
  kind: Kind;
  lang: Lang;
  referral: string;
  confirm_sent_at: number;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
};

/**
 * The sign-ups of the marketing site on `database`, with their mails rendered
 * from `files` into the outbox: what serves their routes (`serve`), and whether
 * a code is a confirmed sign-up's crew link (`isShareCode`).
 */
export function createSignups({
  database,
  site,
  files,
  now = Date.now,
  budget = new RequestBudget({ burst: SIGNUP_BURST, refillMs: SIGNUP_REFILL_MS }),
  perClient = new RequestBudget({ burst: CLIENT_BURST, refillMs: CLIENT_REFILL_MS }),
  trustProxy = false,
}: SignupsOptions) {
  /** A page of the site at `path`, in `lang`. */
  const pageUrl = (lang: Lang, path: string) => `${site.origin}${lang === "en" ? "/en" : ""}${path}`;
  /** A mail's link to `action` (confirm or unsubscribe) with its token. */
  const linkUrl = (action: string, value: string) =>
    `${site.origin}/api/signups/${action}?token=${encodeURIComponent(value)}`;

  /** Queue the confirm mail for a sign-up with a fresh confirm token. */
  async function sendConfirm(
    tx: Queryable,
    row: Pick<SignupRow, "email" | "lang" | "unsubscribe">,
    confirm: string,
  ) {
    const mail = await renderMail(files, "signup_confirm", row.lang, row.email, {
      confirm_url: linkUrl("confirm", confirm),
      unsubscribe_url: linkUrl("unsubscribe", row.unsubscribe),
    });
    if (mail) await enqueue(tx, mail, now());
  }

  /** Take a sign-up: new, or a confirm mail again for one not yet confirmed. */
  async function signUp(body: Json): Promise<void> {
    const email = signupEmail(body.email);
    if (!email) throw new HttpError(400, "email is not an email address");
    if (body.kind !== "player" && body.kind !== "host")
      throw new HttpError(400, "kind must be player or host");
    const kind: Kind = body.kind;
    const lang: Lang = body.lang === "en" ? "en" : "de";
    const page = typeof body.page === "string" ? body.page.slice(0, MAX_PAGE_LENGTH) : null;
    const invite = signupInvite(body.invite);
    const at = now();
    const confirm = token();
    const unsubscribe = token();

    await database.transaction(async (tx) => {
      const { rows } = await tx.query<SignupRow>(
        `SELECT * FROM marketing_signups WHERE email = $1 AND kind = $2 FOR UPDATE`,
        [email, kind],
      );
      const known = rows[0];
      if (!known) {
        // Another sign-up for the same address may have just made it: then that one mails.
        const made = await tx.query(
          `INSERT INTO marketing_signups (id, email, kind, lang, page, invite_type, invite_code, referral,
             confirm_hash, unsubscribe, created_at, confirm_sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT (email, kind) DO NOTHING`,
          [
            newId(),
            email,
            kind,
            lang,
            page,
            invite?.type ?? null,
            invite?.code ?? null,
            referralCode(),
            hash(confirm),
            unsubscribe,
            at,
          ],
        );
        if (made.rowCount) await sendConfirm(tx, { email, lang, unsubscribe }, confirm);
        return;
      }
      // On the list already, or a confirm mail went out lately: nothing more.
      if (known.confirmed_at !== null && known.unsubscribed_at === null) return;
      if (at - known.confirm_sent_at < RESEND_AFTER_MS) return;
      // The first invite it came with stays.
      await tx.query(
        `UPDATE marketing_signups SET lang = $2, confirm_hash = $3, confirm_sent_at = $4,
           invite_type = coalesce(invite_type, $5), invite_code = coalesce(invite_code, $6)
         WHERE id = $1`,
        [known.id, lang, hash(confirm), at, invite?.type ?? null, invite?.code ?? null],
      );
      await sendConfirm(tx, { email, lang, unsubscribe: known.unsubscribe }, confirm);
    });
  }

  /**
   * Confirm the sign-up `value` was sent for: where its page goes next, or
   * null for a link that is unknown, too old or already used. The link is
   * spent: its hash is replaced by one nobody holds. A player's confirmation
   * queues ask_pc_friend with their crew link.
   */
  async function confirm(value: string): Promise<string | null> {
    const at = now();
    return database.transaction(async (tx) => {
      const { rows } = await tx.query<SignupRow>(
        `SELECT * FROM marketing_signups WHERE confirm_hash = $1 FOR UPDATE`,
        [hash(value)],
      );
      const row = rows[0];
      if (!row || at - row.confirm_sent_at > CONFIRM_TTL_MS) return null;
      await tx.query(
        `UPDATE marketing_signups SET confirmed_at = $2, unsubscribed_at = NULL, confirm_hash = $3
         WHERE id = $1`,
        [row.id, at, hash(token())],
      );
      if (row.kind === "host") return pageUrl(row.lang, "/host/");
      const share = pageUrl(row.lang, `/share/?code=${row.referral}`);
      const mail = await renderMail(files, "ask_pc_friend", row.lang, row.email, {
        share_url: share,
        unsubscribe_url: linkUrl("unsubscribe", row.unsubscribe),
      });
      if (mail) await enqueue(tx, mail, at);
      return share;
    });
  }

  /** Take the sign-up `value` was sent for off the list; its language, or null for an unknown link. */
  async function unsubscribe(value: string): Promise<Lang | null> {
    const { rows } = await database.query<{ lang: Lang }>(
      `UPDATE marketing_signups SET unsubscribed_at = coalesce(unsubscribed_at, $2)
       WHERE unsubscribe = $1 RETURNING lang`,
      [value, now()],
    );
    return rows[0]?.lang ?? null;
  }

  /** Whether `code` is a confirmed, subscribed sign-up's crew link code. */
  async function isShareCode(code: string): Promise<boolean> {
    const { rows } = await database.query(
      `SELECT 1 FROM marketing_signups
       WHERE referral = $1 AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`,
      [code],
    );
    return rows.length > 0;
  }

  /** The language of the sign-up a confirm or unsubscribe link is for, or null for an unknown or expired one. */
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
        `<body class="legal"><header class="lg-nav"><a class="wordmark" href="${site.origin}/">${WORDMARK}</a></header>` +
        `<main class="lg-main"><h1>${both((c) => c.title)}</h1><p class="lead">${both((c) => c.text)}</p>` +
        (form &&
          `<form method="post" action="${form}"><button class="copy" type="submit">${both((c) => c.button ?? "")}</button></form>`) +
        `</main></body></html>`,
    );
  }

  /** Serve a sign-up request under /api/signups; false for a path or method it does not know. */
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (path === "/api/signups" && method === "POST") {
      // Each client's own budget first, so one client sending many runs out alone; the server's
      // in all only stops a flood from many at once.
      const waitMs = perClient.take(clientOf(req, trustProxy)) || budget.take("signups");
      if (waitMs > 0) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(Math.ceil(waitMs / 1000)),
        });
        res.end(JSON.stringify({ error: "too many sign-ups right now; try again" }));
        return true;
      }
      await signUp(await readJson(req, MAX_SIGNUP_BODY_BYTES));
      res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
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
      const next = value ? await confirm(value) : null;
      // An unknown, old or used link still lands on the site, which offers signing up again.
      res.writeHead(303, { location: next ?? `${site.origin}/`, "cache-control": "no-store" }).end();
      return true;
    }
    const lang = value ? await unsubscribe(value) : null;
    page(res, lang ? 200 : 404, lang, lang ? UNSUBSCRIBED : INVALID);
    return true;
  }

  return {
    isShareCode,
    /** Serve a sign-up request; false for any other. */
    async serve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith("/api/signups")) return false;
      // Only on the site's own host, which its forms and mail links use: the app's host keeps its routes.
      if (req.headers.host?.toLowerCase() !== site.host.toLowerCase()) return false;
      try {
        return await route(req, res, url);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        // Never the address or the body: only what kind of failure it was.
        if (status === 500)
          console.error("[swiff] sign-up failed:", error instanceof Error ? error.name : typeof error);
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: status === 500 ? "internal error" : (error as Error).message }));
        return true;
      }
    },
  };
}

export type Signups = ReturnType<typeof createSignups>;
