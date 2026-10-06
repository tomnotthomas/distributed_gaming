// Copies marketing's built launch set (the folder their launch-src/build.py
// writes) into web/marketing/, which the server serves behind MARKETING_PAGES
// (server/src/marketing.ts):
//
//   node server/scripts/import-launch-pages.mjs <built launch set>
//
// (`--target <dir>` imports into another folder instead of web/marketing/.)
//
// Run it again for every new build marketing hands over; it replaces
// web/marketing/ whole, and only once the whole set has been read and
// written: it builds the new set beside the old one and swaps it in at the
// end, so a set it refuses leaves web/marketing/ as it was. The generated
// files are not edited beyond three things:
//
// - The brand becomes one token. The product name (`--name`, default the name
//   the set was built with), its wordmark (the name in capitals) and the
//   site's origin (`--site`) turn into {{brand}}, {{wordmark}}, {{site}} and
//   {{siteHost}}, which the server fills in from server/src/brand.ts and
//   SITE_ORIGIN as it serves each file. Routes and file names keep what the
//   build made of them (/lanterel-os/).
// - Every form posts to the server's sign-up endpoint (the form-endpoint meta).
// - An English page's FAQ structured data (FAQPage JSON-LD) says what the page
//   shows: the build writes the German questions into it on every page, so it
//   is made again from the page's own visible FAQ, in English.
//
// The set's own _redirects, README.md and macOS ._ files are left behind: the
// server routes the invite paths itself.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TARGET = fileURLToPath(new URL("../../web/marketing", import.meta.url));
/** The endpoint every form posts to (server/src/signups.ts). */
const FORM_ENDPOINT = "/api/signups";
const TEXT = new Set([".html", ".txt", ".css", ".js", ".json", ".md", ".xml", ".svg"]);
const SKIPPED = new Set(["_redirects", "README.md"]);

/** `s` with every character a regular expression gives a meaning escaped, to match it as it is. */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The set's text with its brand and origin turned into tokens. Lower-case names stay: they are URLs. */
function tokenize(text, name, site) {
  return text
    .replace(new RegExp(escape(site), "g"), "{{site}}")
    .replace(new RegExp(`\\b${escape(new URL(site).host)}\\b`, "g"), "{{siteHost}}")
    .replace(new RegExp(`\\b${escape(name)}\\b`, "g"), "{{brand}}")
    .replace(new RegExp(`\\b${escape(name.toUpperCase())}\\b`, "g"), "{{wordmark}}")
    .replace(
      /<meta name="form-endpoint" content="[^"]*">/g,
      `<meta name="form-endpoint" content="${FORM_ENDPOINT}">`,
    );
}

/** An element's inner HTML as plain text: its tags gone, its character references read. */
function plainText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (_, ref) => {
      const named = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (ref[0] !== "#") return named[ref.toLowerCase()];
      return String.fromCodePoint(
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)),
      );
    })
    .trim();
}

/**
 * `html` with its FAQPage JSON-LD made from its visible FAQ (each
 * `<summary><span data-t="qN">` and the `<p data-t="aN">` after it), in
 * `lang`. A page without both, or whose visible FAQ is empty, is left as it is.
 */
export function faqJsonLd(html, lang) {
  const block =
    /<script type="application\/ld\+json">\s*(\{[\s\S]*?"@type":\s*"FAQPage"[\s\S]*?\})\s*<\/script>/.exec(
      html,
    );
  if (!block) return html;
  const asked = [
    ...html.matchAll(
      /<summary><span data-t="(q\d+)">([\s\S]*?)<\/span>[\s\S]*?<\/summary>\s*<p data-t="a\d+">([\s\S]*?)<\/p>/g,
    ),
  ];
  if (!asked.length) return html;
  const data = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: lang,
      mainEntity: asked.map(([, , question, answer]) => ({
        "@type": "Question",
        name: plainText(question),
        acceptedAnswer: { "@type": "Answer", text: plainText(answer) },
      })),
    },
    null,
    2,
  );
  // "<" never closes the script early: JSON allows it escaped.
  return html.replace(block[1], () => data.replace(/</g, "\\u003c"));
}

/** Every file under `dir`, depth first, leaving out macOS metadata (._ files and .DS_Store). */
function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("._") || entry === ".DS_Store") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/**
 * Build the set at `source` beside `target` (`<target>.importing`), then swap it
 * in for `target`. Throws, leaving `target` alone, on a set it refuses. An old
 * set an interrupted import left aside (`<target>.previous`), with no `target`,
 * is put back first.
 */
function importSet(source, target, name, site) {
  const previous = `${target}.previous`;
  // An import stopped between promote's two renames left the only copy of the old pages aside: they come back first.
  if (!existsSync(target) && existsSync(previous)) renameSync(previous, target);
  const staging = `${target}.importing`;
  rmSync(staging, { recursive: true, force: true });
  let count = 0;
  try {
    for (const path of files(source)) {
      const rel = relative(source, path);
      if (SKIPPED.has(rel)) continue;
      const out = join(staging, rel);
      mkdirSync(dirname(out), { recursive: true });
      if (TEXT.has(extname(path))) {
        const text = readFileSync(path, "utf8");
        if (text.includes("{{"))
          throw new Error(`${rel} already holds a {{ token: refusing to guess what it means`);
        const english = rel.startsWith(`en${sep}`) && extname(rel) === ".html";
        writeFileSync(
          out,
          english ? faqJsonLd(tokenize(text, name, site), "en") : tokenize(text, name, site),
        );
      } else cpSync(path, out);
      count++;
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  promote(staging, target);
  return count;
}

/**
 * Put the built set at `staging` in place of `target`. The old `target` is
 * moved aside (`<target>.previous`) rather than deleted until the new one is
 * in, and moved back if that fails, so `target` is never left missing.
 * `rename` is renameSync, or a stand-in for a test.
 */
export function promote(staging, target, rename = renameSync) {
  const previous = `${target}.previous`;
  rmSync(previous, { recursive: true, force: true });
  const had = existsSync(target);
  if (had) rename(target, previous);
  try {
    rename(staging, target);
  } catch (error) {
    if (had) rename(previous, target);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string", default: "Lanterel" },
      site: { type: "string", default: "https://lanterel.de" },
      target: { type: "string", default: TARGET },
    },
  });
  const source = positionals[0];
  if (!source || !existsSync(join(source, "index.html"))) {
    console.error(
      "usage: node server/scripts/import-launch-pages.mjs <built launch set> [--name Lanterel] [--site https://lanterel.de] [--target web/marketing]",
    );
    process.exit(1);
  }
  const target = resolve(values.target);
  const count = importSet(source, target, values.name, new URL(values.site).origin);
  console.log(`imported ${count} files into ${relative(process.cwd(), target) || "."}`);
}
