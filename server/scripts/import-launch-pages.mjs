// Copies marketing's built launch set (the folder their launch-src/build.py
// writes) into web/marketing/, which the server serves behind MARKETING_PAGES
// (server/src/marketing.ts):
//
//   node server/scripts/import-launch-pages.mjs <built launch set>
//
// (`--target <dir>` imports into another folder instead of web/marketing/.)
//
// A server reads web/marketing/ when it starts: its page routes, and each
// file the first time it is asked for. So an import takes effect on the next
// start, which every deploy is; restart a server that is running.
//
// Run it again for every new build marketing hands over; it replaces
// web/marketing/ whole, and only once the whole set has been read and
// written: it builds the new set beside the old one and swaps it in at the
// end, so a set it refuses leaves web/marketing/ as it was. The generated
// files are not edited beyond three things:
//
// - The brand becomes one token. The product name (`--name`, default the name
//   the set was built with), its wordmark (the name in capitals), the site's
//   origin (`--site`) and the app's origin its links into the app go to
//   (`--app`) turn into {{brand}}, {{wordmark}}, {{site}}, {{siteHost}} and
//   {{app}}, which the server fills in from server/src/brand.ts, SITE_ORIGIN
//   and PUBLIC_ORIGIN as it serves each file. Routes and file names keep what the
//   build made of them (/lanterel-os/).
// - No page asks for an email address: there is no waitlist and no sign-up
//   endpoint, so a page's form-endpoint meta is dropped.
// - The privacy pages say nothing about reminders by email: the product sends
//   none (withoutReminders).
// - A crew's time together is a "Zockrunde" / "gaming session", as the app
//   says it, never an evening or a night: people play whenever suits them.
//   The set still says Crew-Abend / crew night and "meist abends"; MEETUP_WORDING
//   rewrites those phrases, and no time-of-day word stays. A set built with the
//   neutral term leaves it nothing to do.
// - Every "Crew gründen" and join button signs in with Steam on the app's
//   origin and lands on the app's crew pages: the set links to the static
//   crew page (/auth/steam/login?to=/share/…, the build's preview), which the
//   app replaces with /crews (signInPath). The sign-in has to start on the
//   app's origin, whose session it sets, so the link is {{app}}/auth/steam/login.
// - An English page's FAQ structured data (FAQPage JSON-LD) says what the page
//   shows: the build writes the German questions into it on every page, so it
//   is made again from the page's own visible FAQ, in English.
//
// The set's own _redirects, README.md, GLOSSARY.md and macOS ._ files are left
// behind: the server routes the invite paths itself. So is stage2/, the
// archived pages about renting a PC out for money: the launch is stage 1, and
// nothing links or routes to them. And so are the static crew pages (share/,
// en/share/ and their crewpage.js and crewpage.css): the crew page is the
// app's, and the server sends /share/ there. And the mails (emails/): the
// product sends none.

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
const TEXT = new Set([".html", ".txt", ".css", ".js", ".json", ".md", ".xml", ".svg"]);
const SKIPPED = new Set([
  "_redirects",
  "README.md",
  "GLOSSARY.md",
  "stage2",
  "share",
  join("en", "share"),
  join("assets", "js", "crewpage.js"),
  join("assets", "css", "crewpage.css"),
  "emails",
  // A crew link and a friend seat are the app's to show (marketing.ts appInvitePath): their templates are never served.
  "crew",
  join("en", "crew"),
  "seat",
  join("en", "seat"),
]);

/** `s` with every character a regular expression gives a meaning escaped, to match it as it is. */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The set's meetup and time-of-day wording, phrase by phrase, and what the
 * app says instead (crewCopy.ts: "Zockrunde", "Zockrunde ansagen";
 * "session", "gaming session"). Whole phrases, longest first, so German keeps
 * its articles and nothing in a key, a class or a URL (night.*, /night/,
 * crewnight.css) is touched.
 */
export const MEETUP_WORDING = [
  // German
  ["So läuft ein Crew-Abend", "So läuft eine Zockrunde"],
  ["Erinnerung vor Crew-Abenden per Mail?", "Erinnerung vor Zockrunden per Mail?"],
  [
    "an eure Crew-Abende (zum Beispiel, wenn ein Abend angesagt wird,",
    "an eure Zockrunden (zum Beispiel, wenn eine Zockrunde angesagt wird,",
  ],
  ["an eure Crew-Abende zu erinnern", "an eure Zockrunden zu erinnern"],
  ["Erinnerungen an Crew-Abende", "Erinnerungen an Zockrunden"],
  ["an Crew-Abende erinnert werden", "an Zockrunden erinnert werden"],
  ["lädt dich zum Crew-Abend ein", "lädt dich zur Zockrunde ein"],
  ["einen Crew-Abend organisiert", "eine Zockrunde organisiert"],
  ["startet euer Crew-Abend", "startet eure Zockrunde"],
  ["Heute Abend geht", "Heute geht"],
  ["Abend in WhatsApp ansagen", "Zockrunde in WhatsApp ansagen"],
  ["Abend angesagt.", "Zockrunde angesagt."],
  ["Abend ansagen", "Zockrunde ansagen"],
  ["So viel wie ein Abend, an dem du selbst zockst,", "So viel, wie wenn du selbst darauf zockst,"],
  ["ein paar Abende im Monat", "ein paar Mal im Monat"],
  ["wie es abends PCs gibt", "wie es PCs gibt"],
  ["der seinen PC abends teilt", "der seinen PC teilt"],
  ["Mein PC hat abends Platz", "Mein PC hat Platz"],
  ["meist abends ab 20 Uhr", "wenn der PC frei ist"],
  [">Der Abend<", ">Die Zockrunde<"],
  // "Zockrunde" is feminine where "Crew-Abend" was not: the articles go with it.
  ["vor jedem Crew-Abend", "vor jeder Zockrunde"],
  ["jedem Crew-Abend", "jeder Zockrunde"],
  ["einen Crew-Abend", "eine Zockrunde"],
  ["ein Crew-Abend", "eine Zockrunde"],
  ["euer Crew-Abend", "eure Zockrunde"],
  ["zum Crew-Abend", "zur Zockrunde"],
  ["dem Crew-Abend", "der Zockrunde"],
  ["Crew-Abend", "Zockrunde"],
  ["Zockabende", "Zockrunden"],
  ["Zockabend", "Zockrunde"],
  ["Testabende", "Testrunden"],
  ["Testabend", "Testrunde"],
  // English
  ["How a crew night works", "How a gaming session works"],
  ["Reminders before crew nights, by email?", "Reminders before gaming sessions, by email?"],
  [
    "your crew nights (for example, when a night is planned",
    "your gaming sessions (for example, when a session is planned",
  ],
  ["reminders about your crew nights", "reminders about your gaming sessions"],
  ["crew night reminders", "session reminders"],
  ["invited you to a crew night", "invited you to a gaming session"],
  ["set up a crew night", "set up a gaming session"],
  ["Your crew night starts", "Your gaming session starts"],
  ["Friday is game night", "On Friday you play"],
  ["having a game night", "having a gaming session"],
  ["Game night Friday", "Gaming session Friday"],
  ["Ready for game night?", "Ready to play?"],
  ["Ready for <b>game night?</b>", "Ready to <b>play?</b>"],
  ["mostly evenings from 8 pm", "whenever the PC is free"],
  ["Tonight at 9", "Today at 9"],
  ["It's on tonight", "It's on today"],
  ["It&#x27;s on tonight", "It&#x27;s on today"],
  ["Pick a night", "Pick a time"],
  ["Plan a night", "Plan a session"],
  ["Post the night on WhatsApp", "Post the session on WhatsApp"],
  ["About as much as an evening of playing yourself,", "About as much as playing on it yourself,"],
  ["a few evenings a month", "a few times a month"],
  ["test evenings", "test sessions"],
  ["as there are PCs in the evening", "as there are PCs"],
  ["who shares their PC in the evening", "who shares their PC"],
  ["from the crew in the evenings", "from the crew"],
  ["so you can move the night", "so you can move it"],
  ["crew night", "gaming session"],
  ["Crew night", "Gaming session"],
];

/**
 * Slips in marketing's build the pages should not show, each with what it
 * should say; a build that fixes one leaves its entry nothing to do.
 */
export const CORRECTIONS = [
  // A stray slash after the legal basis on the English privacy page.
  ["(§ 25(2) TDDDG). /", "(§ 25(2) TDDDG)."],
  // There is no waitlist: the host FAQ does not promise players from one.
  [" Ob später auch Mac-Spieler von unserer Warteliste dazukommen, entscheidest du.", ""],
  [" Whether Mac players from our waitlist join later is up to you.", ""],
];

/** `text` with the set's meetup and time-of-day wording put the app's way (MEETUP_WORDING), and its slips corrected. */
export function neutralWording(text) {
  return [...MEETUP_WORDING, ...CORRECTIONS].reduce((out, [from, to]) => out.replaceAll(from, to), text);
}

/** `html` without the privacy page's section on reminders by email, German or English. */
export function withoutReminders(html) {
  // Up to the next section, or to where the page's text ends when it is the last one.
  return html.replace(
    /<h2>(?:Wenn du dich erinnern lässt|When you ask for reminders)<\/h2>[\s\S]*?(?=<h2>|<\/main>|$)/g,
    "",
  );
}

/**
 * Where the app takes a sign-in the set sends to its static crew page
 * (`to`, decoded): its crews (/crews), founding one at once for a player who
 * has none yet (found=1, web/src/swiff/crews.ts takeLanding), with the PC card
 * first for someone bringing the gaming PC (?pc=1). Someone joining (?joined=1,
 * from an invite page) lands on their crews. The app picks its own language.
 */
export function signInPath(to) {
  const url = new URL(to, "https://x.invalid");
  if (url.searchParams.get("joined") === "1") return "/crews";
  if (url.searchParams.get("pc") === "1") return "/crews?found=1&pc=1";
  return "/crews?found=1";
}

/** The set's links to the app's Steam sign-in, on the app's origin and into its crew pages. */
export function wireSignIn(html) {
  return html.replace(/href="(?:\/en)?\/auth\/steam\/login\?to=([^"]*)"/g, (_, to) => {
    let path;
    try {
      path = signInPath(decodeURIComponent(to));
    } catch {
      path = "/crews?found=1";
    }
    return `href="{{app}}/auth/steam/login?to=${encodeURIComponent(path)}"`;
  });
}

/** The set's text with its brand and origins turned into tokens. Lower-case names stay: they are URLs. */
function tokenize(text, name, site, app) {
  return text
    .replace(new RegExp(escape(app), "g"), "{{app}}")
    .replace(new RegExp(escape(site), "g"), "{{site}}")
    .replace(new RegExp(`\\b${escape(new URL(site).host)}\\b`, "g"), "{{siteHost}}")
    .replace(new RegExp(`\\b${escape(name)}\\b`, "g"), "{{brand}}")
    .replace(new RegExp(`\\b${escape(name.toUpperCase())}\\b`, "g"), "{{wordmark}}")
    .replace(/<meta name="form-endpoint" content="[^"]*">\n?/g, "");
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
  // Each JSON-LD script on its own, never a match running from one into the next: only the FAQPage one is rebuilt.
  const block = [
    ...html.matchAll(/<script type="application\/ld\+json">\s*(\{(?:(?!<\/script>)[\s\S])*\})\s*<\/script>/g),
  ].find((m) => /"@type":\s*"FAQPage"/.test(m[1]));
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

/** Every file under `dir`, depth first, leaving out macOS metadata (._ files and .DS_Store) and whatever SKIPPED names, relative to `root`. */
function* files(dir, root = dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("._") || entry === ".DS_Store") continue;
    const path = join(dir, entry);
    if (SKIPPED.has(relative(root, path))) continue;
    if (statSync(path).isDirectory()) yield* files(path, root);
    else yield path;
  }
}

/**
 * Build the set at `source` beside `target` (`<target>.importing`), then swap it
 * in for `target`. Throws, leaving `target` alone, on a set it refuses. An old
 * set an interrupted import left aside (`<target>.previous`), with no `target`,
 * is put back first.
 */
function importSet(source, target, name, site, app) {
  const previous = `${target}.previous`;
  // An import stopped between promote's two renames left the only copy of the old pages aside: they come back first.
  if (!existsSync(target) && existsSync(previous)) renameSync(previous, target);
  const staging = `${target}.importing`;
  rmSync(staging, { recursive: true, force: true });
  let count = 0;
  try {
    for (const path of files(source)) {
      const rel = relative(source, path);
      const out = join(staging, rel);
      mkdirSync(dirname(out), { recursive: true });
      if (TEXT.has(extname(path))) {
        const text = readFileSync(path, "utf8");
        if (text.includes("{{"))
          throw new Error(`${rel} already holds a {{ token: refusing to guess what it means`);
        const page = extname(rel) === ".html";
        const tokens = neutralWording(tokenize(text, name, site, app));
        const wired = page ? withoutReminders(wireSignIn(tokens)) : tokens;
        writeFileSync(out, page && rel.startsWith(`en${sep}`) ? faqJsonLd(wired, "en") : wired);
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
      app: { type: "string", default: "https://swiff.onrender.com" },
      target: { type: "string", default: TARGET },
    },
  });
  const source = positionals[0];
  if (!source || !existsSync(join(source, "index.html"))) {
    console.error(
      "usage: node server/scripts/import-launch-pages.mjs <built launch set> [--name Lanterel] [--site https://lanterel.de] [--app https://swiff.onrender.com] [--target web/marketing]",
    );
    process.exit(1);
  }
  const target = resolve(values.target);
  const count = importSet(
    source,
    target,
    values.name,
    new URL(values.site).origin,
    new URL(values.app).origin,
  );
  console.log(`imported ${count} files into ${relative(process.cwd(), target) || "."}`);
}
