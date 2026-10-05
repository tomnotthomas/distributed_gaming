// The streamer VM test, on the host: the platform and the renter.
//
// Runs the real Swiff server (in memory) and a real renter: a headless Chromium
// on the real /rtc page. The VM's agent (mkosi.extra/usr/libexec/swiff/streamer-vmtest)
// reaches this harness at 10.0.2.2, QEMU's address for the host, to fetch the
// session grant and to report what it saw. The grant is made only when the
// agent asks, as swiff-hostd gets it at claim time, so the 5-minute key is fresh.
//
//   SWIFF_HARNESS_TOKEN=<token> node harness.mjs --server-port <p> --harness-port <h> --out <results.json>
//
// Exits 0 when every expected check passed. Needs the server and web app built,
// and Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, as run-test.sh sets it).

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: {
    "server-port": { type: "string" },
    "harness-port": { type: "string" },
    out: { type: "string" },
  },
});
const SERVER_PORT = Number(values["server-port"]);
const HARNESS_PORT = Number(values["harness-port"]);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HTTP = `http://127.0.0.1:${SERVER_PORT}`;
// Only the VM may talk to the harness: /grant hands out a live session key. run-test.sh
// makes the token and gives it to the VM as a credential, never on a command line.
const TOKEN = process.env.SWIFF_HARNESS_TOKEN ?? "";
if (TOKEN.length < 32) throw new Error("SWIFF_HARNESS_TOKEN is not set (run-test.sh makes one)");
const authorized = (header) => {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};
// What the VM dials: QEMU's user network maps 10.0.2.2 to the host's loopback.
const VM_SERVER_URL = `ws://10.0.2.2:${SERVER_PORT}`;

const MACHINE = "vm-host-1";
const MACHINE_KEY = "streamer-vmtest-machine-key";
const ROOM_SECRET = "streamer-vmtest-room-secret-long-enough";
const SESSION_SECRET = "streamer-vmtest-session-secret-long-enough";
const HOST = { authorization: `Bearer ${MACHINE_KEY}` };

// Every check the run must pass, from the VM and from the renter's browser.
const EXPECTED = [
  "renter's PipeWire is up",
  "synthetic gamescope node is in the renter's PipeWire",
  "swiff-pipewire-grant gave the streamer the renter's socket",
  "renter cannot open /dev/uinput",
  "streamer can open /dev/uinput with its primary group alone",
  "streamer cannot read the renter's home",
  "streamer: encoding with x264",
  "streamer: registered; waiting for the renter",
  "streamer: video capture is flowing",
  "streamer: audio capture is flowing",
  "streamer: the renter joined",
  "udev marks Swiff virtual keyboard as the streamer's",
  "udev marks Swiff virtual mouse as the streamer's",
  "udev marks Swiff virtual pointer as the streamer's",
  "renter decodes the picture at 1280x720",
  "renter's video plays",
  "renter receives a sound track",
  "renter's key W reaches the virtual keyboard, down and up",
  "renter's left click reaches the virtual mouse, down and up",
  "renter's pointer moves the virtual pointer",
  "renter's plain F2 reaches the virtual keyboard, down and up",
  "renter's Ctrl+Alt+Delete, Ctrl+Alt+F3 and Alt+F4 never reach the virtual keyboard",
  "renter's Delete, Ctrl and Alt alone reach the virtual keyboard, down and up",
  "streamer exits 0 when the session ends",
];

const results = new Map();
const inputs = [];
const logs = [];
let session = null;
let finished = false;

/**
 * Text with the session's credentials taken out: the join ticket and the session
 * key, by value, and anything that looks like a ticket in a URL. Everything this
 * harness prints or writes to the results file goes through it, because a
 * Playwright error quotes the URL it was opening, and that URL carries the ticket.
 */
function redact(text) {
  let out = String(text);
  for (const secret of [session?.claim?.ticket, session?.grant?.sessionKey]) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out.replace(/ticket=[^\s&"')]+/g, "ticket=<redacted>");
}

function record(name, ok, detail = "") {
  const safe = redact(detail);
  results.set(name, { ok, detail: safe });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${safe ? ` (${safe})` : ""}`);
}

async function call(method, path, headers, body) {
  const res = await fetch(`${HTTP}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function until(check, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// --- The platform ------------------------------------------------------------

const { mintRenterSession } = await import(resolve(REPO, "server/dist/access.js"));
const { SESSION_COOKIE } = await import(resolve(REPO, "server/dist/signin.js"));
const { REPORT } = await import(resolve(REPO, "server/dist/test/report.js"));
const RENTER = {
  cookie: `${SESSION_COOKIE}=${mintRenterSession(SESSION_SECRET, "76561198000000001", 3600)}`,
};

const server = spawn(process.execPath, [resolve(REPO, "server/dist/index.js")], {
  cwd: resolve(REPO, "server"),
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    ROOM_SECRET,
    SESSION_SECRET,
    MACHINE_KEYS: `${MACHINE}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`,
    DATABASE_URL: "",
  },
  stdio: "ignore",
});
// The server must not outlive the harness, however the harness ends: a normal
// exit, an uncaught start-up failure, or a signal before stopAll is in place.
let stopping = false;
process.on("exit", () => server.kill());
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (!stopping) process.exit(1);
  });
}
await until(
  () =>
    fetch(`${HTTP}/api/ping`).then(
      (r) => r.ok,
      () => false,
    ),
  "the server",
  90_000,
);
console.log(`server on ${HTTP}`);

/** swiff-hostd's part up to the streamer: offered, claimed by a renter, host session started. */
async function makeSession() {
  const offered = await call("PUT", `/api/machines/${MACHINE}/availability`, HOST, {
    available: true,
    ...REPORT,
  });
  if (offered.status !== 200) throw new Error(`offer answered ${offered.status}`);
  const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
  const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`, RENTER);
  if (claim.status !== 200) throw new Error(`claim answered ${claim.status}`);
  const grant = await call("POST", `/api/machines/${MACHINE}/session`, HOST, {
    sessionId: claim.body.sessionId,
  });
  if (grant.status !== 201) throw new Error(`session start answered ${grant.status}`);
  return { claim: claim.body, grant: grant.body };
}

// --- The renter ----------------------------------------------------------------

async function renter() {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.log(`renter page error: ${redact(err.message)}`));
    await page.goto(`${HTTP}/rtc#ticket=${session.claim.ticket}`);
    const connectAt = Date.now();
    await page.getByRole("button", { name: "Connect" }).click();
    const stage = page.getByTestId("stage-video");

    const size = await until(
      () =>
        stage.evaluate((v) => (v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null)).catch(() => null),
      "a decoded frame",
      60_000,
    );
    record(
      "renter decodes the picture at 1280x720",
      size === "1280x720",
      `${size}, ${Date.now() - connectAt} ms after Connect`,
    );
    const playing = await until(
      () => stage.evaluate((v) => v.currentTime > 1).catch(() => false),
      "playback",
      30_000,
    );
    record("renter's video plays", playing);
    const tracks = await stage.evaluate((v) => v.srcObject.getAudioTracks().length);
    record("renter receives a sound track", tracks === 1, `${tracks} audio track(s)`);
    const status = await page.locator(".status").textContent();
    console.log(`renter status: ${status}`);

    // Input: an absolute move over the picture, a click, a key.
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.down("w");
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.up("w");

    const saw = (device, type, code, value) =>
      inputs.some(
        (e) =>
          e.device === device &&
          e.type === type &&
          e.code === code &&
          (value === undefined || e.value === value),
      );
    const waitInput = (check, what) =>
      until(() => check(), what, 15_000).then(
        () => true,
        () => false,
      );
    record(
      "renter's key W reaches the virtual keyboard, down and up",
      await waitInput(
        () => saw("Swiff virtual keyboard", 1, 17, 1) && saw("Swiff virtual keyboard", 1, 17, 0),
        "KEY_W",
      ),
    );
    record(
      "renter's left click reaches the virtual mouse, down and up",
      await waitInput(
        () => saw("Swiff virtual mouse", 1, 0x110, 1) && saw("Swiff virtual mouse", 1, 0x110, 0),
        "BTN_LEFT",
      ),
    );
    record(
      "renter's pointer moves the virtual pointer",
      await waitInput(() => saw("Swiff virtual pointer", 3, 0), "ABS_X"),
    );

    // Keys that act on the PC: the sink drops the reboot and console-switch
    // combinations but still sends their modifiers, while a plain F2 (sent
    // last, as a marker) still arrives. Then Delete, Ctrl and Alt alone.
    const keyboard = () => inputs.filter((e) => e.device === "Swiff virtual keyboard" && e.type === 1);
    const before = keyboard().length;
    for (const combo of ["Control+Alt+Delete", "Control+Alt+F3", "Alt+F4", "F2"]) {
      await page.keyboard.press(combo, { delay: 100 });
      await new Promise((r) => setTimeout(r, 150));
    }
    record(
      "renter's plain F2 reaches the virtual keyboard, down and up",
      await waitInput(
        () => saw("Swiff virtual keyboard", 1, 60, 1) && saw("Swiff virtual keyboard", 1, 60, 0),
        "KEY_F2",
      ),
    );
    const combos = keyboard().slice(before);
    const values = (code) =>
      combos
        .filter((e) => e.code === code)
        .map((e) => e.value)
        .join("");
    const leaked = [111, 61, 62].filter((code) => values(code) !== "");
    record(
      "renter's Ctrl+Alt+Delete, Ctrl+Alt+F3 and Alt+F4 never reach the virtual keyboard",
      leaked.length === 0 && values(29) === "1010" && values(56) === "101010",
      `leaked codes: [${leaked.join(",")}]; LEFTCTRL values ${values(29)}, LEFTALT values ${values(56)}`,
    );
    const alone = keyboard().length;
    for (const key of ["Delete", "Control", "Alt"]) {
      await page.keyboard.press(key, { delay: 100 });
      await new Promise((r) => setTimeout(r, 150));
    }
    const aloneValues = (code) =>
      keyboard()
        .slice(alone)
        .filter((e) => e.code === code)
        .map((e) => e.value)
        .join("");
    record(
      "renter's Delete, Ctrl and Alt alone reach the virtual keyboard, down and up",
      await waitInput(
        () => aloneValues(111) === "10" && aloneValues(29) === "10" && aloneValues(56) === "10",
        "KEY_DELETE, KEY_LEFTCTRL, KEY_LEFTALT",
      ),
      `DELETE ${aloneValues(111)}, LEFTCTRL ${aloneValues(29)}, LEFTALT ${aloneValues(56)}`,
    );

    // The renter leaves: the server ends the session and puts the streamer out.
    const left = await call("POST", `/api/sessions/${session.claim.sessionId}/leave`, {
      authorization: `Bearer ${session.claim.ticket}`,
    });
    console.log(`renter left: ${left.status}`);
  } finally {
    await browser.close();
  }
}

// --- What the VM talks to ----------------------------------------------------

let renterDone = null;
const harness = createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401);
    return res.end();
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : null;
  const reply = (value) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(value === undefined ? "" : JSON.stringify(value));
  };
  try {
    switch (req.url) {
      case "/ping":
        return reply({ ok: true });
      case "/grant":
        session = await makeSession();
        renterDone = renter().catch((e) => record("renter", false, e.message));
        return reply({
          serverUrl: VM_SERVER_URL,
          hostId: MACHINE,
          sessionKey: session.grant.sessionKey,
          expiresAt: session.grant.expiresAt,
        });
      case "/result":
        record(data.name, data.ok, data.detail);
        return reply();
      case "/input":
        inputs.push(data);
        return reply();
      case "/log":
        logs.push({ ...data, line: redact(data.line) });
        console.log(`  vm +${data.at}s ${redact(data.line)}`);
        return reply();
      case "/finished":
        finished = true;
        return reply();
      default:
        res.writeHead(404);
        return res.end();
    }
  } catch (e) {
    console.log(`harness error on ${req.url}: ${redact(e.message)}`);
    res.writeHead(500);
    res.end();
  }
});
harness.listen(HARNESS_PORT, "127.0.0.1");
console.log(`harness on 127.0.0.1:${HARNESS_PORT}`);

const stopAll = (code) => {
  const missing = EXPECTED.filter((name) => !results.has(name));
  const failed = [...results].filter(([, r]) => !r.ok).map(([name]) => name);
  if (values.out)
    writeFileSync(
      values.out,
      JSON.stringify({ results: Object.fromEntries(results), missing, logs }, null, 2),
    );
  for (const name of missing) console.log(`MISSING ${name}`);
  console.log(
    `${EXPECTED.length - missing.length - failed.filter((f) => EXPECTED.includes(f)).length}/${EXPECTED.length} expected checks passed`,
  );
  server.kill();
  harness.close();
  process.exit(code ?? (missing.length || failed.length ? 1 : 0));
};
stopping = true;
process.on("SIGTERM", () => stopAll(1));
process.on("SIGINT", () => stopAll(1));

// The VM reports /finished once the streamer has exited; give the whole run a ceiling.
const deadline = Date.now() + 9 * 60_000;
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
// A renter that hangs (a stalled browser) must not hang the run: write what there is.
await Promise.race([renterDone, new Promise((r) => setTimeout(r, 30_000))]);
stopAll();
