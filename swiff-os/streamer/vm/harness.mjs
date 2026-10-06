// The streamer VM test, on the host: the platform and the renter.
//
// Runs the real Swiff server (in memory) and a real renter: a headless Chromium
// on the real /rtc page. Then the renter goes back to the same session on the
// Swiff player page, and a crewmate of theirs, on the real wall, asks to watch:
// the renter says yes over the game, the friend watches the VM's picture view
// only, and both talk in the voice chat, each hearing the other. The VM runs no
// game and no Steam: its agent stands in for the PC's Steam agent, so the
// streamer's game-started goes through the server as on a real PC. The VM's agent (mkosi.extra/usr/libexec/swiff/streamer-vmtest)
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
import { openSync, writeFileSync } from "node:fs";
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
  "friend sees the renter's session on the wall",
  "renter gets the friend's request over the stream",
  "friend sees the renter's picture",
  "friend receives the game's sound",
  "friend's connections carry no data channel",
  "friend hears the renter",
  "renter hears the friend",
  "watching leaves the renter's booking as it was",
  "renter stops the watch, and the friend is told",
  "streamer exits 0 when the session ends",
  "swiff-pipewire-grant runs again when pipewire.socket makes a new socket",
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
const RENTER_SESSION = mintRenterSession(SESSION_SECRET, "76561198000000001", 3600);
const RENTER = { cookie: `${SESSION_COOKIE}=${RENTER_SESSION}` };
// The renter's crewmate, who watches.
const FRIEND_SESSION = mintRenterSession(SESSION_SECRET, "76561198000000002", 3600);
const FRIEND = { cookie: `${SESSION_COOKIE}=${FRIEND_SESSION}` };

const server = spawn(process.execPath, [resolve(REPO, "server/dist/index.js")], {
  cwd: resolve(REPO, "server"),
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    ROOM_SECRET,
    SESSION_SECRET,
    MACHINE_KEYS: `${MACHINE}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`,
    DATABASE_URL: "",
    // Every game playable, unchecked: the friend's wall must not wait on Steam's verdicts.
    SWIFF_PLAYABILITY: "off",
  },
  // Its own log beside the results, in this user's build directory, for when it fails.
  stdio: ["ignore", "ignore", openSync(resolve(dirname(values.out), "server.log"), "w")],
});
// The server must not outlive the harness, however the harness ends: a normal
// exit, an uncaught start-up failure, or a signal before stopAll is in place.
let stopping = false;
process.on("exit", () => server.kill());
server.on("exit", (code, signal) => {
  if (!stopping) console.log(`the server exited early (${signal ?? `code ${code}`}); its log is server.log`);
});
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

/**
 * swiff-hostd's part up to the streamer: offered, claimed by a renter, host
 * session started. Like the PC service without its socket, it beats every 5 s
 * from then on: a machine silent for LIVENESS_MS (15 s) is lost, and its
 * session with it, however long the VM takes to start the streamer.
 */
async function makeSession() {
  const beat = () =>
    call("PUT", `/api/machines/${MACHINE}/availability`, HOST, { available: true, ...REPORT });
  const offered = await beat();
  if (offered.status !== 200) throw new Error(`offer answered ${offered.status}`);
  setInterval(() => void beat().catch(() => {}), 5_000).unref();
  const booking = await call("POST", "/api/bookings", RENTER, { gameId: 730, minutes: 30 });
  const claim = await call("POST", `/api/bookings/${booking.body.bookingId}/claim`, RENTER);
  if (claim.status !== 200) throw new Error(`claim answered ${claim.status}`);
  const grant = await call("POST", `/api/machines/${MACHINE}/session`, HOST, {
    sessionId: claim.body.sessionId,
  });
  if (grant.status !== 201) throw new Error(`session start answered ${grant.status}`);
  return { claim: claim.body, grant: grant.body, bookingId: booking.body.bookingId };
}

// --- The renter ----------------------------------------------------------------

// --- Watching ------------------------------------------------------------------

/** Kept in each page: its peer connections, to read their stats, and every data channel made or offered. */
function keepConnections() {
  const Native = window.RTCPeerConnection;
  const kept = [];
  const channels = [];
  class Kept extends Native {
    constructor(config) {
      super(config);
      kept.push(this);
      this.addEventListener("datachannel", (e) => channels.push(`offered:${e.channel.label}`));
    }
    createDataChannel(label, init) {
      channels.push(`made:${label}`);
      return super.createDataChannel(label, init);
    }
  }
  Object.assign(window, { RTCPeerConnection: Kept, __kept: kept, __channels: channels });
}

/**
 * What the page has received on transceiver `mid` of its viewer connections
 * (six transceivers: the picture, the game, the voice line, three voice slots):
 * audio energy, which grows only while someone speaks, and bytes.
 */
const received = (page, mid) =>
  page.evaluate(async (mid) => {
    let energy = 0;
    let bytes = 0;
    for (const pc of window.__kept) {
      if (pc.connectionState === "closed" || pc.getTransceivers().length < 6) continue;
      (await pc.getStats()).forEach((s) => {
        if (s.type !== "inbound-rtp" || s.mid !== mid) return;
        energy += s.totalAudioEnergy ?? 0;
        bytes += s.bytesReceived ?? 0;
      });
    }
    return { energy, bytes };
  }, mid);

/**
 * The renter (`rtc`, on /rtc so far) comes back to the session on the Swiff
 * player page, where viewers get the game only while the player sees it: once
 * the streamer's game-started for the new connection has come through.
 */
async function swiffPlayer(browser, rtc) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addCookies([{ name: SESSION_COOKIE, value: RENTER_SESSION, url: HTTP }]);
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`renter page error: ${redact(err.message)}`));
  await page.addInitScript(keepConnections);
  // What the page's signaling says, by type only (tickets stay out), for when it never gets to the game.
  const frames = [];
  page.on("websocket", (socket) => {
    const note = (way) => (frame) => {
      try {
        const msg = JSON.parse(String(frame.payload));
        if (msg.type !== "ping" && msg.type !== "pong")
          frames.push(`${way}${msg.type}${msg.reason ? `(${msg.reason})` : ""}`);
      } catch {
        // Not JSON: not signaling.
      }
    };
    socket.on("framesent", note(">"));
    socket.on("framereceived", note("<"));
    socket.on("close", () => frames.push("closed"));
  });
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (path.startsWith("/api/")) frames.push(`${res.request().method()} ${path} ${res.status()}`);
  });
  await rtc.close();
  // The page this browser played the session on went away; the Swiff page offers to go back to it.
  await page.goto(`${HTTP}/`);
  const { sessionId, roomId } = session.claim;
  await page.evaluate((play) => localStorage.setItem("swiff.play", JSON.stringify(play)), {
    bookingId: session.bookingId,
    sessionId,
    roomId,
  });
  await page.reload();
  await page.getByTestId("away").getByRole("button", { name: "Reconnect" }).click();
  await until(
    async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return (
        (await page.getByTestId("session").count()) > 0 && (await page.getByTestId("ignition").count()) === 0
      );
    },
    "the game on screen at the renter",
    120_000,
  ).catch(async (e) => {
    const text = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 400);
    console.log(`renter's Swiff page: ${redact(text)}`);
    console.log(`renter's Swiff signaling and API: ${redact(frames.join(" "))}`);
    throw e;
  });
  return page;
}

/** Wake the renter's HUD, which the crew panel hides with, so the next click lands on it. */
async function wakeHud(page) {
  await page.mouse.move(400, 300);
  await page.mouse.move(420 + Math.random() * 40, 320);
  await page.getByTestId("session").and(page.locator('[data-hud="shown"]')).waitFor({ timeout: 10_000 });
}

/** The renter plays on the Swiff page; their crewmate asks to watch from the wall, the renter says yes; they talk. */
async function watching(browser, rtc) {
  const invite = await call("GET", "/api/me/invite", RENTER);
  const joined = await call("POST", `/api/invites/${invite.body.token}/join`, FRIEND);
  if (joined.status !== 200) throw new Error(`joining the crew answered ${joined.status}`);
  const page = await swiffPlayer(browser, rtc);
  const before = await call("GET", `/api/bookings/${session.bookingId}`, RENTER);

  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addCookies([{ name: SESSION_COOKIE, value: FRIEND_SESSION, url: HTTP }]);
  const friend = await context.newPage();
  friend.on("pageerror", (err) => console.log(`friend page error: ${redact(err.message)}`));
  await friend.addInitScript(keepConnections);
  await friend.goto(`${HTTP}/`);
  const line = friend.getByTestId("crew-live-line");
  const listed = await line
    .filter({ hasText: "is playing" })
    .waitFor({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    );
  record("friend sees the renter's session on the wall", listed);
  await line.getByRole("button", { name: "Ask to watch" }).click();

  const asks = page.getByTestId("crew-asks");
  const asked = await asks
    .filter({ hasText: "would like to watch you play" })
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  record("renter gets the friend's request over the stream", asked);
  // A click on the picture takes the pointer; a person lets it go with Escape,
  // which the browser keeps for itself, before they can click anything else.
  await page.evaluate(() => document.exitPointerLock());
  await asks.getByRole("button", { name: "Let them watch" }).click();

  const watched = friend.getByTestId("watch-video");
  const size = await until(
    () =>
      watched.evaluate((v) => (v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null)).catch(() => null),
    "the friend's first frame",
    60_000,
  ).catch(() => null);
  record("friend sees the renter's picture", size !== null, size ?? "no frame");
  const sound = await until(
    async () => (await received(friend, "1")).bytes > 0,
    "the game's sound at the friend",
    20_000,
  ).then(
    () => true,
    () => false,
  );
  record("friend receives the game's sound", sound);
  const channels = await friend.evaluate(() => window.__channels);
  record("friend's connections carry no data channel", channels.length === 0, channels.join(", "));

  // Voice, both ways: each joins, and each receives the other's voice on the voice line.
  const panel = page.getByTestId("crew-panel");
  await wakeHud(page);
  await panel.getByRole("button", { name: "Join voice" }).click();
  await friend.getByTestId("watch-crew").getByRole("button", { name: "Join voice" }).click();
  const heard = (who, what) =>
    until(async () => (await received(who, "2")).energy > 0, what, 30_000).then(
      () => true,
      () => false,
    );
  record("friend hears the renter", await heard(friend, "the renter's voice at the friend"));
  record("renter hears the friend", await heard(page, "the friend's voice at the renter"));

  const after = await call("GET", `/api/bookings/${session.bookingId}`, RENTER);
  record(
    "watching leaves the renter's booking as it was",
    after.body.status === before.body.status && after.body.machine?.id === before.body.machine?.id,
    `${before.body.status} -> ${after.body.status}`,
  );

  await wakeHud(page);
  await panel.getByRole("button", { name: "Stop" }).click();
  const told = await friend
    .getByTestId("watch-wait")
    .filter({ hasText: "stopped sharing with you" })
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  record("renter stops the watch, and the friend is told", told);
  await context.close();
  await page.context().close();
}

async function renter() {
  const browser = await chromium.launch({
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      // A microphone for the voice chat that needs no person: Chromium's own test tone.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
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

    await watching(browser, page).catch((e) => record("watching", false, e.message));

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
