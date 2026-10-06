// The VM test's look at where the app would put Swiff's key on this start
// (rental-key.cjs), for a request queued a minute before it: what the screen
// would say after the restart, from this start's measured-boot log.
const os = require("node:os");
const { bootTrail, keyOf } = require("C:/swiff/desktop/rental-key.cjs");

const boot = Date.now() - os.uptime() * 1000;
console.log(keyOf({ code: "12345678", queuedAt: boot - 60_000, answer: null }, boot, bootTrail())?.state);
