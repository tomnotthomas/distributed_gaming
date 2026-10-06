// `npm run test:e2e` (and, through e2e/scripts/desktop.cjs, `test:e2e:desktop`):
// Playwright launched so that a crashing Electron cannot fill the disk. On Linux
// it runs with the core-dump limit at exactly 1 byte, which tells the kernel to
// skip a piped core dump: under WSL each Electron crash is otherwise written to
// Windows' disk whole, about 40 GB, and a run of failed launches filled the
// host's disk once. The limit is set in bytes with util-linux prlimit (soft and
// hard): `ulimit -c` counts blocks, and any limit but exactly 1 byte still lets
// the kernel pipe the whole dump.

const { spawnSync } = require("node:child_process");

function playwright(args) {
  const cmd = [process.execPath, require.resolve("@playwright/test/cli"), "test", ...args];
  if (process.platform === "linux") {
    const run = spawnSync("prlimit", ["--core=1", "--", ...cmd], { stdio: "inherit" });
    if (run.error) {
      console.error(
        "prlimit (util-linux) is missing: it is needed to keep a crashing Electron from writing a core dump.",
      );
      process.exit(1);
    }
    process.exit(run.status ?? 1);
  }
  const run = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

module.exports = { playwright };

if (require.main === module) playwright(process.argv.slice(2));
