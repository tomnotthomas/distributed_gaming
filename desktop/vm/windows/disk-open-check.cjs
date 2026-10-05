// The Windows VM test's check of how the app's runtime opens disk 0, read-only:
// the name the worker used before (\\.\PhysicalDrive0, which Electron 33's Node
// turned into \\.\PhysicalDrive0\) and the worker's own (diskPath). One line
// each: OK <path> <the GPT header's signature>, or ERR <path> <code>.
const fs = require("node:fs");
const { diskPath } = require("../desktop/rental-worker.cjs");

for (const name of ["\\\\.\\PhysicalDrive0", diskPath(0)]) {
  try {
    const fd = fs.openSync(name, "r");
    const sector = Buffer.alloc(512);
    fs.readSync(fd, sector, 0, 512, 512);
    fs.closeSync(fd);
    console.log(`OK ${name} ${sector.subarray(0, 8).toString("latin1")}`);
  } catch (error) {
    console.log(`ERR ${name} ${error.code}`);
  }
}
