// Copies marketing's built launch set (the folder their launch-src/build.py
// writes) into web/marketing/, which the server serves behind MARKETING_PAGES
// (server/src/marketing.ts):
//
//   node server/scripts/import-launch-pages.mjs <built launch set>
//
// Run it again for every new build marketing hands over; it replaces
// web/marketing/ whole. The generated files are not edited beyond two things:
//
// - The brand becomes one token. The product name (`--name`, default the name
//   the set was built with), its wordmark (the name in capitals) and the
//   site's origin (`--site`) turn into {{brand}}, {{wordmark}}, {{site}} and
//   {{siteHost}}, which the server fills in from server/src/brand.ts and
//   SITE_ORIGIN as it serves each file. Routes and file names keep what the
//   build made of them (/lanterel-os/).
// - Every form posts to the server's sign-up endpoint (the form-endpoint meta).
//
// The set's own _redirects, README.md and macOS ._ files are left behind: the
// server routes the invite paths itself.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", default: "Lanterel" },
    site: { type: "string", default: "https://lanterel.de" },
  },
});
const source = positionals[0];
if (!source || !existsSync(join(source, "index.html"))) {
  console.error(
    "usage: node server/scripts/import-launch-pages.mjs <built launch set> [--name Lanterel] [--site https://lanterel.de]",
  );
  process.exit(1);
}

const TARGET = fileURLToPath(new URL("../../web/marketing/", import.meta.url));
/** The endpoint every form posts to (server/src/signups.ts). */
const FORM_ENDPOINT = "/api/signups";
const TEXT = new Set([".html", ".txt", ".css", ".js", ".json", ".md", ".xml", ".svg"]);
const SKIPPED = new Set(["_redirects", "README.md"]);

const name = values.name;
const site = new URL(values.site).origin;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The set's text with its brand and origin turned into tokens. Lower-case names stay: they are URLs. */
function tokenize(text) {
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

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("._") || entry === ".DS_Store") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

rmSync(TARGET, { recursive: true, force: true });
let count = 0;
for (const path of files(source)) {
  const rel = relative(source, path);
  if (SKIPPED.has(rel)) continue;
  const out = join(TARGET, rel);
  mkdirSync(dirname(out), { recursive: true });
  if (TEXT.has(extname(path))) {
    const text = readFileSync(path, "utf8");
    if (text.includes("{{"))
      throw new Error(`${rel} already holds a {{ token: refusing to guess what it means`);
    writeFileSync(out, tokenize(text));
  } else cpSync(path, out);
  count++;
}
console.log(`imported ${count} files into ${relative(process.cwd(), TARGET) || "."}`);
