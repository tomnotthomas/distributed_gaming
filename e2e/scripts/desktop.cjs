// `npm run test:e2e:desktop`: the Electron e2e (desktop project), launched so that
// a crash cannot fill the disk. On Linux it needs a display (CI wraps it in
// xvfb-run): without one it stops here, once, instead of launching Electron,
// which crashes at start then. And it runs with the core-dump limit at 1 byte,
// which tells the kernel to skip a piped core dump: under WSL each Electron crash
// is otherwise written to Windows' disk whole, about 40 GB, and a run of failed
// launches filled the host's disk once. The limit is set in bytes with util-linux
// prlimit (soft and hard): `ulimit -c` counts blocks, and any limit but exactly 1
// byte still lets the kernel pipe the whole dump.

const { spawnSync } = require("node:child_process");

const args = ["playwright", "test", "--project", "desktop", ...process.argv.slice(2)];

if (process.platform === "linux") {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("No display: run it as CI does, `xvfb-run --auto-servernum npm run test:e2e:desktop`.");
    process.exit(1);
  }
  const run = spawnSync("prlimit", ["--core=1", "--", "npx", ...args], { stdio: "inherit" });
  if (run.error) {
    console.error(
      "prlimit (util-linux) is missing: it is needed to keep a crashing Electron from writing a core dump.",
    );
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}
const run = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(run.status ?? 1);
