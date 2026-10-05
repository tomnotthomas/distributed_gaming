// Swiff Host's entry point. Started with --swiff-rental-worker, it is the
// rental-mode installer's elevated worker (rental-worker.cjs), which the app
// starts as administrator through UAC: no window, no tray, only the worker,
// until the app hangs up. Otherwise it is the app (main.cjs).

const at = process.argv.indexOf("--swiff-rental-worker");
if (at >= 0) {
  const { app } = require("electron");
  const [pipe, token, imageDir] = process.argv.slice(at + 1);
  const { testBuild } = require("./build-kind.cjs");
  const { trustOf } = require("./image-set.cjs");
  require("./rental-worker.cjs")
    .serve(pipe, token, imageDir, trustOf({ dev: testBuild() }))
    .then(
      () => app.exit(0),
      () => app.exit(1),
    );
} else {
  require("./main.cjs");
}
