// `npm run test:e2e:desktop`: the Electron e2e (desktop project), run through
// e2e/scripts/playwright.cjs so that a crash leaves no core dump. On Linux it
// also needs a display (CI wraps it in xvfb-run): without one it stops here,
// once, instead of launching Electron, which crashes at start then.

const { playwright } = require("./playwright.cjs");

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error("No display: run it as CI does, `xvfb-run --auto-servernum npm run test:e2e:desktop`.");
  process.exit(1);
}
playwright(["--project", "desktop", ...process.argv.slice(2)]);
