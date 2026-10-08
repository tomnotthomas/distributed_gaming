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
//
//   npm run boot-policy -- payload --name <release> --shim <efi> --boot-loader <efi>
//       --uki <efi> --mok <cert> --db-cert <cert> [--db-cert <cert> ...]
//       [--previous <payload.json>]
//       A release's boot policy payload, computed from its files
//       (release-policy.ts), with every release of the previous payload but one
//       of the same name. Printed.
//
//   npm run boot-policy -- <payload.json> <private-key.pem>
//       The signed boot policy for ATTESTATION_POLICY (boot-policy.ts says what
//       the payload holds), signed with the release key whose public half is
//       ATTESTATION_POLICY_KEY. Printed; the payload is checked first. An
//       encrypted key is unlocked with $SWIFF_OS_KEY_PASSPHRASE.
//
//   npm run state-key -- revoke <machine-id>
//   npm run state-key -- reinstate <machine-id>
//       Revoke a rental-mode PC's state key (state-key.ts) in the database at
//       DATABASE_URL: its share is destroyed at once, so its state partition
//       never opens again, and it gets no new one. Reinstating lets it ask for
//       a new one, on a freshly formatted partition.

import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { accessFromEnv, MIN_SECRET_LENGTH, mintTicket, newMachineKey, STEAM_ID } from "./access.js";
import { signBootPolicy } from "./boot-policy.js";
import { policyPayload, releaseEntry } from "./release-policy.js";
import { openDatabase } from "./db.js";
import { migrate } from "./schema.js";
import { createStateKeys, databaseStateKeyStore } from "./state-key.js";

const [command, id, ...rest] = process.argv.slice(2);

/** The DER of a certificate file, PEM or DER. */
function readCertificate(data: Buffer): Buffer {
  const pem = data.toString("latin1").match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  return pem ? Buffer.from(pem[1]!.replace(/\s+/g, ""), "base64") : data;
}

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
} else if (command === "boot-policy" && id === "payload") {
  const usage =
    "usage: npm run boot-policy -- payload --name <release> --shim <efi> --boot-loader <efi> --uki <efi> --mok <cert> --db-cert <cert> [--db-cert <cert> ...] [--previous <payload.json>]";
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        shim: { type: "string" },
        "boot-loader": { type: "string" },
        uki: { type: "string", multiple: true },
        mok: { type: "string" },
        "db-cert": { type: "string", multiple: true },
        previous: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  }
  const { name, shim, mok, previous } = values;
  const bootLoader = values["boot-loader"];
  if (!name || !shim || !bootLoader || !values.uki?.length || !mok || !values["db-cert"]?.length) fail(usage);
  try {
    const release = releaseEntry({
      name,
      shim: readFileSync(shim),
      bootLoader: readFileSync(bootLoader),
      ukis: values.uki.map((file) => readFileSync(file)),
      mok: readCertificate(readFileSync(mok)),
      dbCerts: values["db-cert"].map((file) => readCertificate(readFileSync(file))),
    });
    const payload = policyPayload(release, previous ? JSON.parse(readFileSync(previous, "utf8")) : undefined);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    fail(`no payload: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (command === "boot-policy") {
  const keyFile = rest[0];
  if (!id || !keyFile) fail("usage: npm run boot-policy -- <payload.json> <private-key.pem>");
  try {
    const passphrase = process.env.SWIFF_OS_KEY_PASSPHRASE;
    const key = createPrivateKey({
      key: readFileSync(keyFile, "utf8"),
      ...(passphrase ? { passphrase } : {}),
    });
    process.stdout.write(signBootPolicy(JSON.parse(readFileSync(id, "utf8")), key));
  } catch (error) {
    fail(`the policy was not signed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (command === "state-key") {
  const machine = rest[0];
  if ((id !== "revoke" && id !== "reinstate") || !machine)
    fail("usage: npm run state-key -- revoke|reinstate <machine-id>");
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set: point it at the server's Postgres database (see .env.example)");
  const db = openDatabase(url);
  await migrate(db);
  // Revoking and reinstating need no secret: neither reads a share.
  const stateKeys = createStateKeys({ store: databaseStateKeyStore(db), secret: null });
  await (id === "revoke" ? stateKeys.revoke(machine) : stateKeys.reinstate(machine));
  await db.close();
  console.log(id === "revoke" ? `Revoked the state key of ${machine}.` : `Reinstated ${machine}.`);
} else {
  fail(
    "usage: npm run machine-key -- <id> [owner-steam-id]  |  npm run ticket -- <id> [minutes] [origin]  |  npm run boot-policy -- payload ...  |  npm run boot-policy -- <payload.json> <private-key.pem>  |  npm run state-key -- revoke|reinstate <id>",
  );
}
