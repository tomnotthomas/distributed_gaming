// The public marketing site: the launch pages in web/marketing/ (imported by
// server/scripts/import-launch-pages.mjs), in German at their routes and in
// English under /en/. Off unless MARKETING_PAGES=on, and then served only to
// requests for SITE_ORIGIN's host, so the app keeps "/", "/share" and "/host"
// on its own origin while the site has them on its own domain.
//
//   /  /share/  /host/  /lanterel-os/  /impressum/  /datenschutz/   (a folder with index.html)
//   /en/  /en/share/  /en/host/  /en/lanterel-os/  /en/legal-notice/  /en/privacy/
//   /(en/)?(crew|seat|gift|night)/<code>   one template per type, rendered per invite
//   /assets/…  /robots.txt  /sitemap.xml
//
// Off, or on another host, every one of these paths does what it did before.
//
// The pages hold the product's name and the site's origin as tokens, filled in
// here from brand.ts and SITE_ORIGIN. An invite page names only what the
// product knows about its invite (invite-copy.ts), and its buttons carry the
// invite's code on to the sign-up form (?i=type:code), which posts it with the
// email (signups.ts). The share page shows a confirmed sign-up's own crew link.

import { readFile, readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { BRAND, WORDMARK } from "./brand.js";
import { inviteCopy, UNKNOWN_INVITE, type InviteType, type InviteView, type Lang } from "./invite-copy.js";

export const INVITE_TYPES: readonly InviteType[] = ["crew", "seat", "gift", "night"];

/** An invite code in a path or a form: what the product's codes and tokens are made of. */
export const INVITE_CODE = /^[A-Za-z0-9_-]{1,128}$/;

/** The site's origin, and its host as a request names it. */
export type Site = { origin: string; host: string };

/**
 * The marketing site from MARKETING_PAGES and SITE_ORIGIN: null while the
 * pages are off. On without a usable SITE_ORIGIN serves nothing: every link
 * and preview on the pages needs the real origin.
 */
export function siteFromEnv(env: NodeJS.ProcessEnv): Site | null {
  if (env.MARKETING_PAGES?.trim().toLowerCase() !== "on") return null;
  const configured = env.SITE_ORIGIN?.trim() ?? "";
  const url = URL.canParse(configured) ? new URL(configured) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    console.warn(
      "[swiff] MARKETING_PAGES=on needs SITE_ORIGIN (e.g. https://lanterel.de): the pages stay off",
    );
    return null;
  }
  return { origin: url.origin, host: url.host };
}

/** The language a page path is in. */
export const langOf = (path: string): Lang => (path === "/en" || path.startsWith("/en/") ? "en" : "de");

/** Fill a marketing file's tokens. */
export function fillTokens(text: string, site: Site): string {
  return text
    .replaceAll("{{brand}}", BRAND)
    .replaceAll("{{wordmark}}", WORDMARK)
    .replaceAll("{{site}}", site.origin)
    .replaceAll("{{siteHost}}", site.host);
}

/** The marketing files under `dir`, read once each with their tokens filled. */
export function marketingFiles(dir: string, site: Site) {
  const cache = new Map<string, Promise<Buffer>>();
  const TEXT = new Set([".html", ".txt", ".css", ".js", ".json", ".xml", ".svg"]);
  return {
    dir,
    /** The file at `rel`, or null when there is none (or `rel` leaves `dir`). */
    async read(rel: string): Promise<Buffer | null> {
      const path = join(dir, normalize(rel));
      const inside = relative(dir, path);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
      let file = cache.get(path);
      if (!file) {
        file = readFile(path).then((raw) =>
          TEXT.has(extname(path)) ? Buffer.from(fillTokens(raw.toString("utf8"), site)) : raw,
        );
        cache.set(path, file);
        file.catch(() => cache.delete(path));
      }
      return file.catch(() => null);
    },
    async text(rel: string): Promise<string | null> {
      return (await this.read(rel))?.toString("utf8") ?? null;
    },
  };
}

export type MarketingFiles = ReturnType<typeof marketingFiles>;

/**
 * The page routes: every folder holding an index.html, at "/<folder>/", but
 * not the assets, the emails, the invite texts or the invite templates, which
 * have routes of their own.
 */
export async function pageRoutes(dir: string): Promise<Map<string, string>> {
  const routes = new Map<string, string>();
  const hidden = new Set(["assets", "emails", "content", ...INVITE_TYPES]);
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const top = child.replace(/^en\//, "").split("/")[0]!;
        if (!hidden.has(top)) await walk(child);
      } else if (entry.name === "index.html") {
        routes.set(rel ? `/${rel}/` : "/", child);
      }
    }
  }
  await walk("");
  return routes;
}

/** A path's invite route: its type, language and code (null for the bare template path). */
export function inviteRoute(path: string): { type: InviteType; lang: Lang; code: string | null } | null {
  const match = /^(\/en)?\/(crew|seat|gift|night)(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  const code = match[3] ?? null;
  if (code !== null && !INVITE_CODE.test(code)) return null;
  return { type: match[2] as InviteType, lang: match[1] ? "en" : "de", code };
}

/** What the product knows about an invite, by its code. */
export type InviteResolver = (type: InviteType, code: string) => Promise<InviteView>;

/**
 * Nothing yet. TODO: a crew invite names its inviter once crews and their
 * signed invite tokens are on main (PR #96, verifyInviteToken in access.ts
 * and the inviter it names); seats, gifts and Nights once they exist.
 */
export const knownInvites: InviteResolver = async () => UNKNOWN_INVITE;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `html` with the inner HTML of every element marked data-t="`key`" replaced by `inner`. */
export function setText(html: string, key: string, inner: string): string {
  const open = new RegExp(`<(\\w+)\\b[^>]*\\bdata-t="${escapeRe(key)}"[^>]*>`, "g");
  let out = "";
  let last = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const start = m.index + m[0].length;
    const tags = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, "g");
    tags.lastIndex = start;
    let depth = 1;
    let end = -1;
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    if (end < 0) break;
    out += html.slice(last, start) + inner;
    last = end;
    open.lastIndex = end;
  }
  return out + html.slice(last);
}

/** `html` with the content of `<meta {attr}="{name}" content="…">` set to `value` (attribute-safe already). */
const setMeta = (html: string, attr: string, name: string, value: string) =>
  html.replace(
    new RegExp(`(<meta ${attr}="${escapeRe(name)}" content=")[^"]*(")`),
    (_, before: string, after: string) => before + value + after,
  );

/**
 * An invite template rendered for one invite: its copy (invite-copy.ts), and
 * its buttons to the sign-up forms carrying `type:code` on as ?i=.
 */
export function renderInvite(
  template: string,
  type: InviteType,
  lang: Lang,
  code: string | null,
  view: InviteView,
): string {
  const copy = inviteCopy(type, lang, view);
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${copy.title} | {{brand}}</title>`);
  html = setMeta(html, "name", "description", copy.description);
  html = setMeta(html, "property", "og:title", copy.ogTitle);
  html = setMeta(html, "property", "og:description", copy.description);
  for (const [key, inner] of Object.entries(copy.text)) html = setText(html, key, inner);
  for (const [from, to] of copy.literal) html = html.replaceAll(from, to);
  if (code) {
    // To the host application (#bewerben) or the waitlist (#beta), with the invite.
    html = html.replace(
      /href="((?:\/en)?\/(?:host\/)?)#(bewerben|beta)"/g,
      (_, path: string, anchor: string) => `href="${path}?i=${type}:${code}#${anchor}"`,
    );
  }
  return html;
}

/** The share page with a sign-up's crew link, or with the bare crew page when `code` is null. */
export function renderShare(template: string, code: string | null): string {
  return template.replace(/\/crew\/(DEINCODE|YOURCODE)/g, code ? `/crew/${code}` : "/crew/");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export type MarketingOptions = {
  site: Site;
  files: MarketingFiles;
  /** Page routes by path (pageRoutes). */
  routes: Map<string, string>;
  /** What the product knows about an invite. Defaults to nothing. */
  invites?: InviteResolver;
  /** Whether `code` is a confirmed sign-up's crew link code (signups.ts). */
  isShareCode: (code: string) => Promise<boolean>;
};

/** Serve a marketing page or file on the site's host; false for anything else. */
export function createMarketing({
  site,
  files,
  routes,
  invites = knownInvites,
  isShareCode,
}: MarketingOptions) {
  function send(
    res: ServerResponse,
    req: IncomingMessage,
    type: string,
    body: Buffer | string,
    headers = {},
  ) {
    res.writeHead(200, { "content-type": MIME[type] ?? "application/octet-stream", ...headers });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  return async function serveMarketing(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (req.headers.host?.toLowerCase() !== site.host.toLowerCase()) return false;
    const path = url.pathname;

    // Every page lives at a folder: "/host" is "/host/".
    if (!path.endsWith("/") && routes.has(`${path}/`)) {
      res.writeHead(308, { location: `${path}/${url.search}` }).end();
      return true;
    }

    const page = routes.get(path);
    if (page) {
      let html = await files.text(page);
      if (html === null) return false;
      const share = /^(\/en)?\/share\/$/.test(path);
      if (share) {
        const code = url.searchParams.get("code");
        const known = code !== null && INVITE_CODE.test(code) && (await isShareCode(code));
        html = renderShare(html, known ? code : null);
      }
      // A share page is one person's: never kept by a cache.
      send(res, req, ".html", html, { "cache-control": share ? "private, no-store" : "no-cache" });
      return true;
    }

    const invite = inviteRoute(path);
    if (invite) {
      const template = await files.text(`${invite.lang === "en" ? "en/" : ""}${invite.type}/index.html`);
      if (template === null) return false;
      const view = invite.code ? await invites(invite.type, invite.code) : UNKNOWN_INVITE;
      const html = renderInvite(template, invite.type, invite.lang, invite.code, view);
      // The copy brings its own {{brand}} tokens.
      send(res, req, ".html", fillTokens(html, site), {
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex",
        // The code stays on this site.
        "referrer-policy": "same-origin",
      });
      return true;
    }

    if (path === "/robots.txt" || path === "/sitemap.xml" || path.startsWith("/assets/")) {
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(1));
      } catch {
        return false;
      }
      // An app asset (the SPA's own /assets/) is not here: it falls through.
      const body = await files.read(rel);
      if (!body) return false;
      send(res, req, extname(rel), body, { "cache-control": "public, max-age=3600" });
      return true;
    }
    return false;
  };
}
