// In the VM, as administrator: pairing this PC with its owner's Steam account
// as the app does it (src/pairing.ts, bundled to C:\swiff\pair.cjs), then Go
// live's TPM step with the machine id and key pairing gave it (src/ek.ts,
// bundled to C:\swiff\ek.cjs). The owner's side, signing in and adding the PC,
// is the test's, on the host.
//
//   node pair-register.cjs start  <server ws url>   a new key, kept DPAPI-protected; the page to open
//   node pair-register.cjs add    <server ws url>   the owner adds this PC, as the /pair page does, with the
//                                                   Steam session cookie the test hands over on stdin
//   node pair-register.cjs finish <server ws url>   ask until the server knows the key, then register the EK
//   node pair-register.cjs forget                   delete the protected key
//
// Prints one JSON line. Neither the key nor its hash (the pairing's claim
// ticket) is ever printed, and the key is never written in the clear: between the steps (and across the restart onto another TPM) it is
// kept as the app keeps it, encrypted by Windows' DPAPI (the app's safeStorage),
// here with the machine's scope, which an SSH session without a password can use.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { askPaired, keyHashOf, newMachineKey, pairingCode, pairLink } = require("C:/swiff/pair.cjs");

const KEY_FILE = "C:/swiff/pair/key.dpapi";

/** `data` through DPAPI's Protect or Unprotect (machine scope), handed over in the environment, never the command line. */
function dpapi(verb, data) {
  const script =
    "Add-Type -AssemblyName System.Security; $s=[Security.Cryptography.DataProtectionScope]::LocalMachine; " +
    (verb === "protect"
      ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:SWIFF_PAIR_IN), $null, $s))"
      : "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:SWIFF_PAIR_IN), $null, $s))");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, SWIFF_PAIR_IN: data },
    encoding: "utf8",
  }).trim();
}

/** Ask every 2 s, as the app does, for up to `seconds`. */
async function waitPaired(url, key, seconds) {
  let answer = "unanswered";
  for (let i = 0; i < seconds / 2; i++) {
    answer = await askPaired(url, key);
    if (typeof answer === "object") return answer;
    await new Promise((done) => setTimeout(done, 2000));
  }
  return answer;
}

async function main() {
  const [step, url] = process.argv.slice(2);
  if (step === "forget") {
    fs.rmSync(KEY_FILE, { force: true });
    console.log(JSON.stringify({ forgotten: !fs.existsSync(KEY_FILE) }));
    return;
  }
  if (step === "start") {
    const key = newMachineKey();
    fs.mkdirSync("C:/swiff/pair", { recursive: true });
    fs.writeFileSync(KEY_FILE, dpapi("protect", key));
    const hash = await keyHashOf(key);
    const link = pairLink(url, hash);
    // Before the owner has added it, the server knows no such key.
    const before = await askPaired(url, key);
    const out = {
      hashIsSha256: /^[0-9a-f]{64}$/.test(hash),
      linkCarriesHash:
        link ===
        `${new URL(url).protocol === "wss:" ? "https" : "http"}://${new URL(url).host}/pair?k=${hash}`,
      codeIsHash: pairingCode(hash) === `${hash.slice(0, 3)}-${hash.slice(3, 6)}`.toUpperCase(),
      before,
      keyProtected:
        !fs.readFileSync(KEY_FILE, "utf8").includes(key) &&
        dpapi("unprotect", fs.readFileSync(KEY_FILE, "utf8")) === key,
    };
    const line = JSON.stringify(out);
    console.log(
      JSON.stringify({ ...out, keyInOutput: line.includes(key), hashInOutput: line.includes(hash) }),
    );
    return;
  }
  if (step === "add") {
    // The owner's side of /pair: the hash goes from this process straight to the server, never to any output.
    const cookie = fs.readFileSync(0, "utf8").trim();
    const hash = await keyHashOf(dpapi("unprotect", fs.readFileSync(KEY_FILE, "utf8")));
    const origin = `${new URL(url).protocol === "wss:" ? "https" : "http"}://${new URL(url).host}`;
    const res = await fetch(`${origin}/api/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `swiff_session=${cookie}` },
      body: JSON.stringify({ keyHash: hash }),
    });
    const body = await res.json().catch(() => null);
    console.log(JSON.stringify({ status: res.status, machineId: body?.machineId ?? null }));
    return;
  }
  if (step !== "finish")
    throw new Error("usage: pair-register.cjs start|add|finish <server ws url> | forget");
  const key = dpapi("unprotect", fs.readFileSync(KEY_FILE, "utf8"));
  const paired = await waitPaired(url, key, 60);
  if (typeof paired !== "object") {
    console.log(JSON.stringify({ paired }));
    return;
  }
  const { createWorker } = require("C:/swiff/desktop/rental-worker.cjs");
  const { readRental } = require("C:/swiff/desktop/rental.cjs");
  const { registerEk } = require("C:/swiff/ek.cjs");
  const worker = await createWorker({ imageDir: "C:/swiff/no-image" });
  let worked;
  try {
    worked = await worker.apply({ op: "ek" });
  } catch (error) {
    worked = { error: String(error?.message ?? error) };
  }
  const checked = (await readRental())?.facts.checked ?? null;
  const machine = { url, machineId: paired.machineId, machineKey: key };
  const registered = checked?.certificate ? await registerEk(machine, checked) : null;
  // The same EK again, with the same pairing: the server has it already.
  const again = checked?.certificate ? await registerEk(machine, checked) : null;
  // A key nobody paired, for the same machine: refused, which the app answers with Pair again.
  const stranger = checked?.certificate
    ? await registerEk({ ...machine, machineKey: newMachineKey() }, checked)
    : null;
  console.log(
    JSON.stringify({
      paired,
      worked: worked?.error ? { error: worked.error } : { ek: Boolean(worked?.ek?.certificate) },
      certificate: checked?.certificate ?? null,
      registered,
      again,
      stranger,
    }),
  );
}

main().catch((error) => {
  console.log(JSON.stringify({ error: String(error?.stack ?? error) }));
  process.exit(1);
});
