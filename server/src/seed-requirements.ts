// Fill the game_requirements table for the catalogue's games.
//
//   npm run seed-requirements                  the wall's nine, Steam's most played and every curated game
//   npm run seed-requirements -- 1245620 730   just these appids
//
// Writes to the SQLite file at DATABASE_PATH (from .env). Asks Steam's keyless
// store API one game at a time, pausing between requests, so a full run takes
// a few minutes. Re-running refreshes every row it reaches.

import { DatabaseSync } from "node:sqlite";
import { mostPlayed } from "./catalog.js";
import { curatedRequirements, RequirementsTable, seedRequirements } from "./requirements.js";
import { WALL_APPIDS } from "./steam.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const path = process.env.DATABASE_PATH;
if (!path) fail("DATABASE_PATH is not set: point it at the server's SQLite file (see .env.example)");

const args = process.argv.slice(2).map(Number);
if (args.some((id) => !Number.isInteger(id) || id <= 0))
  fail("usage: npm run seed-requirements -- [appid ...]");

const appids = args.length
  ? args
  : [...curatedRequirements().keys(), ...WALL_APPIDS, ...(await mostPlayed().catch(() => []))];

const db = new DatabaseSync(path);
const table = new RequirementsTable(db);
console.log(`Seeding requirements for ${new Set(appids).size} games into ${path}`);
const outcomes = await seedRequirements(table, appids);
db.close();

for (const outcome of outcomes)
  console.log(
    "source" in outcome
      ? `${outcome.appid}  ${outcome.source}`
      : `${outcome.appid}  skipped: ${outcome.skipped}`,
  );
const written = outcomes.filter((o) => "source" in o).length;
console.log(`${written} written, ${outcomes.length - written} skipped`);
