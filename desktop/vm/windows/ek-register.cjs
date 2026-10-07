// In the VM, as administrator: Go live's TPM step as the app takes it. The
// elevated worker reads the TPM's EK certificate (rental-worker.cjs, op "ek"),
// the app's own read finds it without administrator rights (rental.cjs), and
// the app registers it with the server (src/ek.ts, bundled to C:\swiff\ek.cjs).
//
//   node ek-register.cjs <server ws url> <machine id> <machine key>
//
// Prints one JSON line: what the worker read, what the app read, and how the
// registration went.

const { createWorker } = require("C:/swiff/desktop/rental-worker.cjs");
const { readRental } = require("C:/swiff/desktop/rental.cjs");
const { registerEk } = require("C:/swiff/ek.cjs");

async function main() {
  const [url, machineId, machineKey] = process.argv.slice(2);
  const worker = await createWorker({ imageDir: "C:/swiff/no-image" });
  let worked;
  try {
    worked = await worker.apply({ op: "ek" });
  } catch (error) {
    worked = { error: String(error?.message ?? error) };
  }
  const checked = (await readRental())?.facts.checked ?? null;
  const registered = checked?.certificate ? await registerEk({ url, machineId, machineKey }, checked) : null;
  console.log(JSON.stringify({ worked, checked, registered }));
}

main().catch((error) => {
  console.log(JSON.stringify({ error: String(error?.stack ?? error) }));
  process.exit(1);
});
