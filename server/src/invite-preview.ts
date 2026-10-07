// The link preview of the app's own invite links, what WhatsApp, Discord,
// Telegram and iMessage show when a player shares one: a crew link
// (/invite/<token>) and a friend seat (/seat/<token>). The app is one SPA with
// no tags of its own, so the server writes them into its index.html for those
// paths: marketing's preview copy and card (web/marketing/content/og.json,
// assets/img/og-*.jpg), naming who asks when the product knows them (the
// crew's admin, the seat's host, by their Steam persona) and nobody otherwise.
// The token itself is never written into the page.
//
// The cards are served from the app's own origin (/og/og-<type>-<lang>.jpg),
// so a preview has its picture whether or not the marketing site is on.

import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import type { Lang } from "./invite-copy.js";

/** The invite links the app has, by the preview each takes from og.json. */
export type PreviewType = "crew" | "rig";

/** One preview's copy in one language, as og.json has it. */
type PreviewCopy = { title: string; title_named: string; desc: string };

export type Previews = Record<PreviewType, Record<Lang, PreviewCopy>>;

/** An app invite path's preview type and token, or null for any other path. */
export function previewPath(path: string): { type: PreviewType; token: string } | null {
  const match = /^\/(invite|seat)\/([\w-]{1,128})\/*$/.exec(path);
  if (!match) return null;
  return { type: match[1] === "invite" ? "crew" : "rig", token: match[2]! };
}

/** The language a preview is in: English when the reader asks for it first, else German. */
export const previewLang = (req: IncomingMessage): Lang =>
  /^\s*en\b/i.test(req.headers["accept-language"] ?? "") ? "en" : "de";

/** The card for `type` in `lang`: the file under the marketing images and the app's path to it. */
export const previewCard = (type: PreviewType, lang: Lang) => `og-${type}-${lang}.jpg`;

/** The marketing card a request for /og/<file> asks for, or null for any other path. */
export function cardFile(path: string): string | null {
  const match = /^\/og\/(og-(?:crew|rig)-(?:de|en)\.jpg)$/.exec(path);
  return match ? match[1]! : null;
}

/** og.json's crew and seat previews, read from the marketing set in `dir`; null when it has none. */
export async function readPreviews(dir: string): Promise<Previews | null> {
  try {
    const all = JSON.parse(await readFile(join(dir, "content", "og.json"), "utf8")) as Record<
      string,
      Record<Lang, PreviewCopy>
    >;
    return all.crew && all.rig ? { crew: all.crew, rig: all.rig } : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** og.json's text with its brand token filled, escaped for an attribute. */
const text = (s: string) => escapeHtml(s.replaceAll("{{brand}}", BRAND));

/**
 * The app's index.html with the preview of an invite: its title, description
 * and Open Graph tags in `lang`, naming `name` when there is one, and its card
 * (`card`, an absolute URL).
 */
export function invitePreview(
  html: string,
  copy: PreviewCopy,
  name: string | null,
  lang: Lang,
  card: string,
): string {
  const title = name ? text(copy.title_named.replace("{name}", () => name)) : text(copy.title);
  const description = text(copy.desc);
  const tags = [
    `<meta name="description" content="${description}" />`,
    `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(BRAND)}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${escapeHtml(card)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${lang}"`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>\n    ${tags}`);
}
