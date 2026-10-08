// In the VM, as administrator: pairing this PC with its owner's Steam account
// as the app does it (src/pairing.ts, bundled to C:\swiff\pair.cjs), then Go
// live's TPM step with the machine id and key pairing gave it (src/ek.ts,
// bundled to C:\swiff\ek.cjs). The owner's side, signing in and adding the PC,
// is the test's, on the host.
//
//   node pair-register.cjs start  <server ws url>   a new key, kept in C:\swiff\pair\key; the page to open
//   node pair-register.cjs finish <server ws url>   ask until the server knows the key, then register the EK
//
// Prints one JSON line. The key itself is never printed.

const fs = require("node:fs");
const { askPaired, keyHashOf, newMachineKey, pairingCode, pairLink } = require("C:/swiff/pair.cjs");

const KEY_FILE = "C:/swiff/pair/key";

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
  if (step === "start") {
    const key = newMachineKey();
    fs.mkdirSync("C:/swiff/pair", { recursive: true });
    fs.writeFileSync(KEY_FILE, key);
    const hash = await keyHashOf(key);
    // Before the owner has added it, the server knows no such key.
    const before = await askPaired(url, key);
    console.log(JSON.stringify({ hash, code: pairingCode(hash), link: pairLink(url, hash), before }));
    return;
  }
  if (step !== "finish") throw new Error("usage: pair-register.cjs start|finish <server ws url>");
  const key = fs.readFileSync(KEY_FILE, "utf8");
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
