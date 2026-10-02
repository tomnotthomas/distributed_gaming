// Fill the game_requirements table for the catalogue's games.
//
//   npm run seed-requirements                  the wall's nine, Steam's most played and every curated game
//   npm run seed-requirements -- 1245620 730   just these appids
//
// Writes to the Postgres database at DATABASE_URL (from .env), making its
// tables first if the server has not yet. Asks Steam's keyless store API one
// game at a time, pausing between requests, so a full run takes a few minutes.
// Re-running refreshes every row it reaches.

import { mostPlayed } from "./catalog.js";
import { openDatabase } from "./db.js";
import { curatedRequirements, RequirementsTable, seedRequirements } from "./requirements.js";
import { migrate } from "./schema.js";
import { WALL_APPIDS } from "./steam.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set: point it at the server's Postgres database (see .env.example)");

const args = process.argv.slice(2).map(Number);
if (args.some((id) => !Number.isInteger(id) || id <= 0))
  fail("usage: npm run seed-requirements -- [appid ...]");

const appids = args.length
  ? args
  : [...curatedRequirements().keys(), ...WALL_APPIDS, ...(await mostPlayed().catch(() => []))];

const db = openDatabase(url);
await migrate(db);
const table = new RequirementsTable(db);
// Not the URL itself: it carries the password.
console.log(`Seeding requirements for ${new Set(appids).size} games into the database at DATABASE_URL`);
const outcomes = await seedRequirements(table, appids);
await db.close();

for (const outcome of outcomes)
  console.log(
    "source" in outcome
      ? `${outcome.appid}  ${outcome.source}`
      : `${outcome.appid}  skipped: ${outcome.skipped}`,
  );
const written = outcomes.filter((o) => "source" in o).length;
console.log(`${written} written, ${outcomes.length - written} skipped`);
