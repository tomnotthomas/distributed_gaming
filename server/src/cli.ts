// Credentials minted by hand: machine keys always, join tickets only for
// testing. A renter gets their ticket by claiming a booking (api.ts).
//
//   npm run machine-key -- <machine-id> [owner-steam-id]
//       A new key for one gaming PC. Prints the key (paste it into the host app)
//       and the MACHINE_KEYS entry (put it in .env). The key is shown once. With
//       the owner's 17-digit Steam id, the entry records them, and the owner is
//       never matched to their own PC.
//
//   npm run ticket -- <machine-id> [minutes] [origin]
//       A join link for one renter. Needs ROOM_SECRET from .env. Default 60
//       minutes. With an origin (the tunnel URL), prints the whole link.

import { accessFromEnv, MIN_SECRET_LENGTH, mintTicket, newMachineKey, STEAM_ID } from "./access.js";

const [command, id, ...rest] = process.argv.slice(2);

/** Print the message and exit with an error. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === "machine-key") {
  if (!id) fail("usage: npm run machine-key -- <machine-id> [owner-steam-id]");
  if (/[,:\s]/.test(id)) fail("a machine id cannot contain commas, colons or spaces");
  const owner = rest[0];
  if (owner !== undefined && !STEAM_ID.test(owner)) fail("the owner must be a 17-digit Steam id");
  const { key, hash } = newMachineKey();
  const entry = owner ? `${id}:${hash}:${owner}` : `${id}:${hash}`;
  console.log(`Machine key for ${id} (paste into the host app, shown once):\n\n  ${key}\n`);
  console.log(`Add to MACHINE_KEYS in .env (comma-separate several machines):\n\n  ${entry}\n`);
} else if (command === "ticket") {
  if (!id) fail("usage: npm run ticket -- <machine-id> [minutes] [origin]");
  const { secret } = accessFromEnv(process.env);
  if (!secret)
    fail(`ROOM_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — see .env.example`);
  const minutes = Number(rest[0] ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) fail("minutes must be a positive number");
  const origin = (rest[1] ?? "").replace(/\/+$/, "");
  // In the fragment, not the query: a fragment never reaches a server log, a
  // proxy or a Referer header.
  const path = `/rtc#ticket=${mintTicket(secret, id, Math.round(minutes * 60))}`;
  console.log(origin ? `${origin}${path}` : path);
} else {
  fail("usage: npm run machine-key -- <id> [owner-steam-id]  |  npm run ticket -- <id> [minutes] [origin]");
}
