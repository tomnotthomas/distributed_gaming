// `npm run test:e2e:desktop`: the Electron e2e (desktop project), launched so that
// a crash cannot fill the disk. On Linux it needs a display (CI wraps it in
// xvfb-run): without one it stops here, once, instead of launching Electron,
// which crashes at start then. And it runs with the core-dump limit at 1 byte,
// which tells the kernel to skip a piped core dump: under WSL each Electron crash
// is otherwise written to Windows' disk whole, about 40 GB, and a run of failed
// launches filled the host's disk once.

const { spawnSync } = require("node:child_process");

const args = ["playwright", "test", "--project", "desktop", ...process.argv.slice(2)];

if (process.platform === "linux") {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("No display: run it as CI does, `xvfb-run --auto-servernum npm run test:e2e:desktop`.");
    process.exit(1);
  }
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const run = spawnSync("sh", ["-c", `ulimit -c 1 && exec npx ${quoted}`], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
const run = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(run.status ?? 1);
