// The rental-mode session test, on the host side (session-test.sh runs it in a
// network namespace of its own). It plays the platform, the owner and a renter
// around a VM running the session test build of the image:
//
//   1. the platform: the real server, built (`npm run build`), with the
//      insecure-dev attestation verifier, and a TURN relay (coturn). Both have
//      addresses that look public to the VM (198.51.100.10 and .20, TEST-NET-2),
//      so the image's firewall lets the VM reach them as it would the internet.
//   2. the owner: offers the PC with the machine key, as their app does before
//      the PC restarts into rental mode, and hands the VM swiff-hostd's config on
//      a fixture disk, as their app will.
//   3. the VM: OVMF with Secure Boot and a software TPM. swiff-hostd attests,
//      opens its persistent state (a disk of its own here) and offers the PC.
//   4. a renter: headless Chromium on the hosted site, signed in, who holds
//      Launch on the PC, sees Steam's sign-in code on Ignition, gets the game
//      once Steam signs in, plays it on the path ICE picks (both seats hold a
//      relay allocation; SWIFF_SESSION_RELAY_ONLY=1 leaves only the relay),
//      reloads and reconnects, and ends the session.
//   5. the restart: swiff-hostd restarts the PC clean, and in the next boot
//      attests again, opens the same state and offers the PC again.
//
// Every step is one line, PASS or FAIL, with what the VM reported on its serial
// console (sessiontest-monitor, swiff-hostd's and the streamer's logs). The run
// passes only when every expected step passed. A stand-in Steam (no account,
// no network) and a test picture in gamescope's place (no GPU) are the only
// parts not as on a real PC; see sessiontest/.
//
//   node session-harness.mjs --run <dir> --image <swiffos-sessiontest.raw>
//
// Needs TURNSERVER (coturn's turnserver) and Playwright's Chromium
// (PLAYWRIGHT_BROWSERS_PATH), both as session-test.sh checks.

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { encode } from "uqr";

const { values } = parseArgs({ options: { run: { type: "string" }, image: { type: "string" } } });
const RUN = resolve(values.run ?? "");
const IMAGE = resolve(values.image ?? "");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * SWIFF_SESSION_RELAY_ONLY=1: the renter behind a home router, on a private
 * address the image's firewall refuses, so only the relay connects them. By
 * default the renter's browser shares this namespace's addresses, which look
 * public to the VM, and ICE picks the path.
 */
const RELAY_ONLY = process.env.SWIFF_SESSION_RELAY_ONLY === "1";
const SERVER_IP = "198.51.100.10";
const TURN_IP = "198.51.100.20";
const PORT = 8199;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MACHINE = "lanterel-vm-1";
const NAME = "Lanterel VM";
const MACHINE_KEY = randomBytes(32).toString("base64url");
const ROOM_SECRET = randomBytes(32).toString("base64url");
const SESSION_SECRET = randomBytes(32).toString("base64url");
const TURN_SECRET = randomBytes(32).toString("base64url");
const STATE_KEY_SECRET = randomBytes(32).toString("base64url");
/** The two sign-in links the stand-in Steam shows, one after the other. */
const CODES = [1, 2].map(() => `https://s.team/q/1/${randomInt(1e9, 1e10)}${randomInt(1e8, 1e9)}`);

const OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd";
const OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.fd";

// Every step the run must pass: the VM's, per boot, and the harness's own.
const EXPECTED = [
  "boot1/secure-boot",
  "boot1/root-is-verity",
  "boot1/node-22",
  "boot1/session-runs-steam-agent",
  "boot1/zbar-reads-steam-code",
  "boot1/hostd-active",
  "boot1/hostd-attested",
  "boot1/state-open",
  "boot1/hostd-offered",
  "renter sees the PC on the wall",
  "renter's Ignition waits on the PC",
  "hostd serves the renter's session",
  "streamer encodes",
  "streamer registers with its session key",
  "renter's page shows Steam's code from the PC",
  "renter's page shows Steam's fresh code",
  "nothing billed before Steam signs in",
  "boot1/streamer-own-user",
  "boot1/streamer-no-capabilities",
  "boot1/streamer-environment",
  "boot1/streamer-steam-socket",
  "boot1/renter-cannot-read-streamer",
  "boot1/agent-socket",
  "boot1/steam-remembers-nothing",
  "streamer relays Steam's sign-in and the game on screen",
  "renter plays the game in Swiff",
  "billed from the first frame after sign-in",
  RELAY_ONLY ? "media through the TURN relay alone" : "media on the path ICE picked",
  "renter reloads and reconnects to the same session",
  "renter ends the session",
  "streamer stops when the session ends",
  "hostd restarts the PC clean",
  "boot2/hostd-attested",
  "boot2/state-open",
  "boot2/hostd-offered",
  "the PC is offered again after the restart",
];

const results = new Map();
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)} s`;
const secrets = [MACHINE_KEY, ROOM_SECRET, SESSION_SECRET, TURN_SECRET, STATE_KEY_SECRET];
/** Text with this run's secrets taken out, and anything that looks like a ticket or a session key. */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out
    .replace(/ticket=[^\s&"')]+/g, "ticket=<redacted>")
    .replace(/s\.team\/q\/\d+\/\d+/g, "s.team/q/<code>");
}
function record(name, ok, detail = "") {
  if (results.has(name) && results.get(name).ok) return;
  const safe = redact(detail);
  results.set(name, { ok, detail: safe });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${safe ? `  (${safe})` : ""}  [${elapsed()}]`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// --- Fixtures -------------------------------------------------------------------

/** A QR code as an X window dump (XWD, 32-bit TrueColor), as xwd would grab it off Steam's window. */
function qrXwd(text) {
  const qr = encode(text, { ecc: "M", border: 4 });
  const scale = 8;
  const side = qr.size * scale;
  const name = Buffer.from("Sign in to Steam\0");
  const fields = [
    100 + name.length,
    7,
    2,
    24,
    side,
    side,
    0,
    0,
    32,
    0,
    32,
    32,
    side * 4,
    4,
    0xff0000,
    0x00ff00,
    0x0000ff,
    8,
    256,
    0,
    side,
    side,
    0,
    0,
    0,
  ];
  const header = Buffer.alloc(100);
  fields.forEach((v, i) => header.writeUInt32BE(v, i * 4));
  const pixels = Buffer.alloc(side * side * 4, 0xff);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (!qr.data[Math.floor(y / scale)][Math.floor(x / scale)]) continue;
      pixels.fill(0x00, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  return Buffer.concat([header, name, pixels]);
}

/** The path SteamSignIn draws for `url` (web/src/swiff/SteamSignIn.tsx): the page's code is this one. */
function drawnPath(url) {
  const qr = encode(url, { ecc: "M", border: 0 });
  let d = "";
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return d;
}

const sbin = (tool) => ["/usr/sbin", "/sbin", "/usr/bin"].map((d) => join(d, tool)).find(existsSync) ?? tool;

function prepare() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(join(RUN, "fixtures", "qr"), { recursive: true });
  mkdirSync(join(RUN, "tpm"));
  const fixtures = join(RUN, "fixtures");
  // swiff-hostd's config, as the owner's app would leave it: the image's
  // streamer (hostd/hostd.example.json) at 720p30 for a VM without a GPU, and
  // its persistent state on a disk of its own, with U's credential on another.
  const hostd = {
    serverUrl: "ws://127.0.0.1:8080",
    machineId: MACHINE,
    machineKeyFile: "/var/lib/swiff/machine-key",
    stateDir: "/var/lib/swiff/state/hostd",
    streamer: {
      command: "/usr/bin/node",
      args: [
        "/usr/lib/swiff/streamer/dist/swiff-streamer.mjs",
        "--pipewire-remote",
        "/run/user/1000/pipewire-0",
        "--steam-socket",
        "/run/swiff/steam/login.sock",
        "--size",
        "1280x720",
        "--fps",
        "30",
        "--bitrate",
        "3000000",
      ],
      uid: 961,
      gid: 961,
    },
    state: {
      device: "/dev/disk/by-id/virtio-swiffstate",
      mountpoint: "/var/lib/swiff/state",
      localShare: "/var/lib/swiff/keep/state-u.cred",
      attestCommand: "/usr/libexec/swiff/sessiontest-attest",
    },
  };
  writeFileSync(join(fixtures, "hostd.json"), `${JSON.stringify(hostd, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(fixtures, "machine-key"), `${MACHINE_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(fixtures, "forward"), `${SERVER_IP} ${PORT}\n`);
  CODES.forEach((code, i) => writeFileSync(join(fixtures, "qr", `${i + 1}.xwd`), qrXwd(code)));
  const mkfs = sbin("mkfs.ext4");
  execFileSync(mkfs, ["-q", "-L", "SWIFFSESS", "-d", fixtures, join(RUN, "fixtures.img"), "16M"]);
  rmSync(fixtures, { recursive: true });
  execFileSync(mkfs, ["-q", "-L", "SWIFFKEEP", join(RUN, "keep.img"), "16M"]);
  // Raw: swiff-hostd formats it as LUKS2 itself the first time the server has no key share for it.
  writeFileSync(join(RUN, "state.img"), "");
  execFileSync("truncate", ["-s", "64M", join(RUN, "state.img")]);
  execFileSync("cp", ["--sparse=always", IMAGE, join(RUN, "disk.raw")]);
  copyFileSync(OVMF_VARS, join(RUN, "vars.fd"));
}

// --- The platform: TURN relay and server ----------------------------------------------

const children = [];
function child(command, args, options = {}) {
  const proc = spawn(command, args, { stdio: "ignore", ...options });
  children.push(proc);
  return proc;
}

/** Which side each allocation the relay granted on a minted credential was for: never the username itself. */
const allocations = new Set();
function startRelay() {
  const fifo = join(RUN, "turnserver.fifo");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  child(process.env.TURNSERVER, [
    "-n",
    `--listening-ip=${TURN_IP}`,
    `--relay-ip=${TURN_IP}`,
    "--listening-port=3478",
    "--min-port=49152",
    "--max-port=49999",
    "--use-auth-secret",
    `--static-auth-secret=${TURN_SECRET}`,
    "--realm=lanterel.test",
    "--no-tls",
    "--no-dtls",
    "--no-cli",
    "--verbose",
    "--simple-log",
    `--log-file=${fifo}`,
    `--userdb=${join(RUN, "turndb")}`,
  ]);
  let rest = "";
  const turnLog = join(RUN, "turnserver.log");
  createReadStream(fifo, "utf8").on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const m = /user <\d+:[\w-]+-(renter|host)>: incoming packet ALLOCATE processed, success/.exec(line);
      if (m) allocations.add(m[1]);
      // Kept with each TURN user, a credential, cut out: only its seat's side stays.
      const safe = line.replace(/(user(?:name=)? ?<)\d+:[\w-]+-(renter|host)>/g, "$1$2>");
      appendFileSync(turnLog, `${safe}\n`);
    }
  });
}

async function startServer() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TURN")));
  const log = openSync(join(RUN, "server.log"), "w");
  const server = child(process.execPath, [join(REPO, "server/dist/index.js")], {
    cwd: join(REPO, "server"),
    stdio: ["ignore", log, log],
    env: {
      ...env,
      PORT: String(PORT),
      ROOM_SECRET,
      SESSION_SECRET,
      MACHINE_KEYS: `${MACHINE}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`,
      DATABASE_URL: "",
      // Every game playable, unchecked: there is no internet here to ask Steam.
      SWIFF_PLAYABILITY: "off",
      TURN_URLS: `turn:${TURN_IP}:3478`,
      TURN_SECRET,
      // Believes the facts of whoever holds the machine key: sessiontest-attest.
      ATTESTATION_VERIFIER: "insecure-dev",
      HOSTING_ATTESTATION: "optional",
      // Seals the state partitions' key shares (server/src/state-key.ts).
      STATE_KEY_SECRET,
    },
  });
  await until(
    () =>
      server.exitCode === null &&
      fetch(`${ORIGIN}/api/ping`).then(
        (r) => r.ok,
        () => false,
      ),
    "the server",
    120_000,
  );
}

const ownerHeaders = { authorization: `Bearer ${MACHINE_KEY}`, "content-type": "application/json" };
/** The owner shares the PC from their app, then it restarts into rental mode. */
async function ownerGoesLive() {
  const res = await fetch(`${ORIGIN}/api/machines/${MACHINE}/availability`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({
      available: true,
      name: NAME,
      hardware: {
        gpu: "AMD Radeon RX 7800 XT",
        vramMb: 16_384,
        ramMb: 32_768,
        cpu: "AMD Ryzen 7 7700",
        cores: 8,
        encoders: ["h264"],
        display: { width: 2560, height: 1440, refreshHz: 144 },
      },
      games: [730, 2073850],
      controls: ["kb", "mouse", "pad"],
      net: { rttMs: 1, jitterMs: 1, upMbps: 100 },
    }),
  });
  if (res.status !== 200) throw new Error(`the owner's offer answered ${res.status}`);
}

// --- The VM --------------------------------------------------------------------------

const serial = join(RUN, "serial.log");
let boot = 0;
const vmLines = [];
/** Reads the serial console as it grows: the monitor's results by boot, and the agents' logs. */
function watchSerial() {
  let offset = 0;
  let rest = "";
  setInterval(() => {
    let text;
    try {
      const data = readFileSync(serial);
      if (data.length <= offset) return;
      text = data.subarray(offset).toString("utf8");
      offset = data.length;
    } catch {
      return;
    }
    const lines = (rest + text).split("\n");
    rest = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      vmLines.push({ boot, line });
      const m = /SWIFF-SESSIONTEST (PASS|FAIL|INFO) (\S+) ?(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === "INFO" && m[2] === "boot") {
        boot++;
        console.log(`----  boot ${boot} of the VM  [${elapsed()}]`);
      } else if (m[1] === "INFO") {
        console.log(`info  boot${boot}/${m[2]} ${redact(m[3])}`);
      } else {
        record(`boot${boot}/${m[2]}`, m[1] === "PASS", m[3]);
      }
    }
  }, 300);
}
const seen = (pattern, inBoot) =>
  vmLines.find((l) => (inBoot === undefined || l.boot === inBoot) && pattern.test(l.line));
const waitVm = (name, ms) =>
  until(() => results.get(name), name, ms).catch(() => record(name, false, "never reported"));

function startVm() {
  const tpm = join(RUN, "tpm");
  child("swtpm", ["socket", "--tpm2", "--tpmstate", `dir=${tpm}`, "--ctrl", `type=unixio,path=${tpm}/sock`]);
  return until(() => existsSync(`${tpm}/sock`), "swtpm", 10_000).then(() =>
    child(
      "qemu-system-x86_64",
      [
        ...[
          "-machine",
          "q35,smm=on,accel=kvm,kernel-irqchip=split",
          "-cpu",
          "host",
          "-smp",
          "2",
          "-m",
          "2048",
        ],
        ...["-global", "driver=cfi.pflash01,property=secure,value=on", "-global", "ICH9-LPC.disable_s3=1"],
        ...["-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${OVMF_CODE}`],
        ...["-drive", `if=pflash,format=raw,unit=1,file=${join(RUN, "vars.fd")}`],
        ...["-device", "intel-iommu,intremap=on"],
        ...["-chardev", `socket,id=chrtpm,path=${tpm}/sock`, "-tpmdev", "emulator,id=tpm0,chardev=chrtpm"],
        ...["-device", "tpm-crb,tpmdev=tpm0"],
        ...["-drive", `if=none,id=os,format=raw,file=${join(RUN, "disk.raw")}`],
        ...["-device", "virtio-blk-pci,drive=os,bootindex=1"],
        ...["-drive", `if=none,id=fix,format=raw,readonly=on,file=${join(RUN, "fixtures.img")}`],
        ...["-device", "virtio-blk-pci,drive=fix"],
        ...["-drive", `if=none,id=keep,format=raw,file=${join(RUN, "keep.img")}`],
        ...["-device", "virtio-blk-pci,drive=keep"],
        ...["-drive", `if=none,id=state,format=raw,file=${join(RUN, "state.img")}`],
        ...["-device", "virtio-blk-pci,drive=state,serial=swiffstate"],
        ...["-netdev", "user,id=n0", "-device", "virtio-net-pci,netdev=n0", "-device", "virtio-rng-pci"],
        ...["-display", "none", "-vga", "none", "-monitor", "none", "-serial", `file:${serial}`],
      ],
      { stdio: ["ignore", "ignore", openSync(join(RUN, "qemu.log"), "w")] },
    ),
  );
}

// --- The renter --------------------------------------------------------------------------

/** In the renter's page: each peer connection's state and its candidate pairs, for a stream that never came. */
async function iceReport() {
  const out = [];
  for (const pc of window.__swiffPeers ?? []) {
    const stats = await pc.getStats();
    const side = (id) => {
      const c = stats.get(id);
      return `${c?.candidateType} ${c?.address}:${c?.port}`;
    };
    const pairs = [];
    stats.forEach((s) => {
      if (s.type === "candidate-pair")
        pairs.push(
          `${side(s.localCandidateId)}->${side(s.remoteCandidateId)} ${s.state}${s.nominated ? " nominated" : ""} req ${s.requestsSent}/${s.responsesReceived}`,
        );
    });
    out.push(`${pc.connectionState}/${pc.iceConnectionState}: ${pairs.join("; ")}`);
  }
  return out.join(" | ");
}

/** In the renter's page: the candidate types and addresses of the pair carrying its live stream. */
async function selectedPair() {
  for (const pc of [...(window.__swiffPeers ?? [])].reverse()) {
    if (pc.connectionState !== "connected") continue;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) continue;
    const side = (id) => {
      const c = stats.get(id);
      return `${c?.candidateType} ${c?.address}:${c?.port}`;
    };
    return `${side(pair.localCandidateId)} -> ${side(pair.remoteCandidateId)}`;
  }
  return null;
}

/**
 * The renter's home network: a network namespace of its own at 10.99.0.2,
 * routed through this one (10.99.0.1), where the server and the relay are. Its
 * address is private, so the image's firewall refuses it: the PC reaches the
 * renter only through the relay, as one behind a home router. Its
 * localhost:8199 is forwarded to the server, so the hosted site loads from a
 * secure context, as it would over https. Returns the namespace's holder pid.
 */
async function renterNetwork() {
  const holder = child("unshare", ["--net", "sleep", "infinity"]);
  const own = readlinkSync("/proc/self/ns/net");
  await until(() => readlinkSync(`/proc/${holder.pid}/ns/net`) !== own, "the renter's network", 5_000);
  const pid = String(holder.pid);
  execFileSync("ip", ["link", "add", "renter0", "type", "veth", "peer", "name", "renter1"]);
  execFileSync("ip", ["link", "set", "renter1", "netns", pid]);
  execFileSync("ip", ["addr", "add", "10.99.0.1/24", "dev", "renter0"]);
  execFileSync("ip", ["link", "set", "renter0", "up"]);
  execFileSync("nsenter", [
    "-t",
    pid,
    "-n",
    "sh",
    "-c",
    "ip link set lo up && ip addr add 10.99.0.2/24 dev renter1 && ip link set renter1 up && ip route add default via 10.99.0.1",
  ]);
  child("nsenter", [
    "-t",
    pid,
    "-n",
    process.execPath,
    "-e",
    `require("node:net").createServer((c) => {
      const up = require("node:net").connect(${PORT}, "10.99.0.1");
      c.pipe(up).pipe(c);
      c.on("error", () => up.destroy());
      up.on("error", () => c.destroy());
    }).listen(${PORT}, "127.0.0.1");`,
  ]);
  return pid;
}

/** Chromium's binary: the full browser when installed, else Playwright's headless shell beside it. */
function chromeBinary() {
  const full = chromium.executablePath();
  if (existsSync(full)) return full;
  const root = dirname(dirname(dirname(full)));
  const shell = readdirSync(root)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .at(-1);
  if (!shell) throw new Error("no Chromium: run npx playwright install chromium-headless-shell");
  return join(root, shell, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

async function renter() {
  const { mintRenterSession } = await import(join(REPO, "server/dist/access.js"));
  const { SESSION_COOKIE } = await import(join(REPO, "server/dist/signin.js"));
  let executablePath;
  if (!RELAY_ONLY) {
    // An interface for the browser to gather on: Chromium uses no loopback addresses.
    execFileSync("ip", ["link", "add", "home0", "type", "veth", "peer", "name", "home1"]);
    execFileSync("ip", ["addr", "add", "10.98.0.2/24", "dev", "home0"]);
    execFileSync("ip", ["link", "set", "home0", "up"]);
    execFileSync("ip", ["link", "set", "home1", "up"]);
  } else {
    const network = await renterNetwork();
    executablePath = join(RUN, "renter-chrome");
    writeFileSync(executablePath, `#!/bin/sh\nexec nsenter -t ${network} -n -- '${chromeBinary()}' "$@"\n`, {
      mode: 0o755,
    });
  }
  const browser = await chromium.launch({
    ...(executablePath && { executablePath }),
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  try {
    const context = await browser.newContext({ baseURL: ORIGIN });
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: mintRenterSession(SESSION_SECRET, "76561198000000001", 3600),
        url: ORIGIN,
      },
    ]);
    // Each peer connection the page makes, kept where the harness can ask it
    // which candidate pair carries the stream.
    await context.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.__swiffPeers = [];
      window.RTCPeerConnection = class extends Native {
        constructor(...args) {
          super(...args);
          window.__swiffPeers.push(this);
        }
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`renter page error: ${redact(err.message)}`));
    const played = () =>
      page.evaluate(async () => {
        const play = JSON.parse(localStorage.getItem("swiff.play") ?? "null");
        if (!play) return null;
        const res = await fetch(`/api/bookings/${play.bookingId}`);
        return { bookingId: play.bookingId, ...(await res.json()) };
      });

    // The wall offers the PC; the renter holds Launch on it.
    await page.goto("/");
    const hero = page.getByTestId("hero");
    const onWall = await until(
      async () =>
        (
          await hero
            .locator(".hero-strip-line")
            .first()
            .textContent()
            .catch(() => "")
        )?.includes(NAME),
      "the PC on the wall",
      60_000,
    ).catch(() => false);
    record("renter sees the PC on the wall", Boolean(onWall));
    await hero.locator("button.resume").click();
    const launch = page.getByRole("button", { name: `Hold to launch on ${NAME}` });
    await until(() => launch.isEnabled().catch(() => false), "Launch", 30_000);
    await launch.hover();
    await page.mouse.down();
    await sleep(900);
    await page.mouse.up();
    const ignition = page.getByTestId("ignition");
    const waiting = await until(() => ignition.isVisible().catch(() => false), "Ignition", 15_000).catch(
      () => false,
    );
    record("renter's Ignition waits on the PC", waiting);

    // The PC hears the claim, starts its streamer, and Steam's code reaches the page.
    await until(() => seen(/\[swiff-hostd\] serving session/), "hostd serving", 60_000).then(
      () => record("hostd serves the renter's session", true),
      () => record("hostd serves the renter's session", false, "no 'serving session' in its log"),
    );
    const code = page.locator('[data-testid="steam-sign-in"] svg path');
    const drawn = () => code.getAttribute("d", { timeout: 1000 }).catch(() => null);
    const first = await until(
      async () => (await drawn()) === drawnPath(CODES[0]),
      "the first code",
      90_000,
    ).catch(() => false);
    record(
      "renter's page shows Steam's code from the PC",
      Boolean(first),
      first
        ? "the code it draws is the one the PC's screen showed"
        : `it draws ${(await drawn()) ? "another code" : "no code"}`,
    );
    const booking = await played();
    record(
      "nothing billed before Steam signs in",
      booking?.status === "claimed",
      `booking ${booking?.status ?? "missing"} while the code is up`,
    );
    const fresh = await until(
      async () => (await drawn()) === drawnPath(CODES[1]),
      "the fresh code",
      30_000,
    ).catch(() => false);
    record("renter's page shows Steam's fresh code", Boolean(fresh));
    const encoding = seen(/\[swiff-streamer\] encoding with (\S+)/);
    record(
      "streamer encodes",
      Boolean(encoding),
      encoding?.line.replace(/^.*encoding with/, "encoding with"),
    );
    record("streamer registers with its session key", Boolean(seen(/registered; waiting for the renter/)));

    // The stand-in Steam signs in; the game starts and the stream shows it.
    const video = page.getByTestId("session-video");
    // Chromium reports 2x2 for a track before its first real frame.
    const size = await until(
      () =>
        video
          .evaluate((v) =>
            v.videoWidth > 2 && v.currentTime > 1 ? `${v.videoWidth}x${v.videoHeight}` : null,
          )
          .catch(() => null),
      "a decoded frame",
      120_000,
    ).catch(() => null);
    if (!size) console.log(`info  renter's ICE: ${await page.evaluate(iceReport).catch((e) => e.message)}`);
    record(
      "renter plays the game in Swiff",
      Boolean(size),
      size ? `${size} on the renter's page` : "no frame",
    );
    const relayed = await until(
      () =>
        ["Steam signed in", "Steam is launching the game", "the game is on screen"].every((m) =>
          seen(new RegExp(`\\[swiff-streamer\\] ${m}`)),
        ),
      "the streamer's log",
      30_000,
    ).catch(() => false);
    record("streamer relays Steam's sign-in and the game on screen", relayed);
    const fps = await until(
      async () => {
        const text = await page
          .getByTestId("hud-stats")
          .textContent()
          .catch(() => "");
        return /\d+ fps/.test(text ?? "") ? text : null;
      },
      "the HUD's frame rate",
      30_000,
    ).catch(() => null);
    const playing = await until(
      async () => {
        const booking = await played();
        return booking?.status === "playing" ? booking : null;
      },
      "the session to start",
      30_000,
    ).catch(() => played());
    record(
      "billed from the first frame after sign-in",
      playing?.status === "playing",
      `booking ${playing?.status}; HUD ${fps ?? "-"}`,
    );
    await until(
      () => allocations.has("renter") && allocations.has("host"),
      "both relay allocations",
      20_000,
    ).catch(() => {});
    // Both seats get the relay on credentials of their own either way; relay
    // alone, the stream's pair must run through it.
    const pair = await page.evaluate(selectedPair).catch(() => null);
    record(
      RELAY_ONLY ? "media through the TURN relay alone" : "media on the path ICE picked",
      allocations.has("renter") && allocations.has("host") && (RELAY_ONLY ? /relay/ : /\S/).test(pair ?? ""),
      `the renter's pair ${pair ?? "unknown"}; relay allocations on the seats' own credentials: ${[...allocations].sort().join(", ") || "none"}`,
    );

    // The page goes away mid-session, and the renter comes back to the same PC.
    await page.reload();
    const away = page.getByTestId("away");
    await until(
      async () => (await away.textContent().catch(() => ""))?.includes("Still yours"),
      "Still yours",
      30_000,
    );
    await away.getByRole("button", { name: "Reconnect" }).click();
    const again = await until(
      () => video.evaluate((v) => v.videoWidth > 2 && v.currentTime > 1).catch(() => false),
      "a frame after reconnecting",
      90_000,
    ).catch(() => false);
    const after = await played();
    record(
      "renter reloads and reconnects to the same session",
      Boolean(again) && after?.bookingId === playing?.bookingId && after?.status === "playing",
      `booking ${after?.status}${after?.bookingId === playing?.bookingId ? ", the same" : ", another"}`,
    );

    // End.
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await page.getByRole("button", { name: "End session" }).click();
    const ended = await until(
      () =>
        page
          .evaluate(
            async (id) => (await (await fetch(`/api/bookings/${id}`)).json()).status,
            playing?.bookingId,
          )
          .then((s) => s === "ended")
          .catch(() => false),
      "the booking to end",
      30_000,
    ).catch(() => false);
    record("renter ends the session", Boolean(ended));
  } finally {
    await browser.close();
  }
}

// --- The run ------------------------------------------------------------------------------

function stopAll() {
  for (const proc of children) proc.kill();
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

try {
  prepare();
  startRelay();
  await startServer();
  console.log(`----  the platform: server ${SERVER_IP}:${PORT}, TURN relay ${TURN_IP}:3478  [${elapsed()}]`);
  await ownerGoesLive();
  watchSerial();
  await startVm();
  console.log(`----  the VM is starting; its console is in ${serial}`);

  await waitVm("boot1/hostd-offered", 600_000);
  if (results.get("boot1/hostd-offered")?.ok) {
    await renter().catch((e) => record("renter", false, e.message));
    await until(() => seen(/\[swiff-hostd\] session \S+ is over/, 1), "the session's end", 60_000).catch(
      () => {},
    );
    const out = seen(/\[swiff-streamer\] the server put the streamer out/, 1);
    record(
      "streamer stops when the session ends",
      Boolean(seen(/\[swiff-hostd\] session \S+ is over/, 1)),
      out?.line.replace(/^.*\[swiff-streamer\] /, ""),
    );
    await until(() => boot >= 2, "the restart", 180_000).catch(() => {});
    record(
      "hostd restarts the PC clean",
      boot >= 2 && Boolean(seen(/\[swiff-hostd\] restarting for a clean PC/, 1)),
    );
    if (boot >= 2) {
      await waitVm("boot2/hostd-offered", 600_000);
      const res = await fetch(`${ORIGIN}/api/machines/${MACHINE}/heartbeat`, {
        method: "POST",
        headers: ownerHeaders,
        body: "{}",
      });
      const view = res.ok ? await res.json() : null;
      record(
        "the PC is offered again after the restart",
        view?.status === "available",
        `status ${view?.status ?? res.status}`,
      );
    }
  }
} catch (e) {
  record("harness", false, e.message);
}

const missing = EXPECTED.filter((name) => !results.has(name));
for (const name of missing) record(name, false, "never reached");
const failed = [...results].filter(([, r]) => !r.ok);
writeFileSync(join(RUN, "results.json"), JSON.stringify(Object.fromEntries(results), null, 2));
appendFileSync(join(RUN, "results.json"), "\n");
console.log(`\n${results.size - failed.length}/${results.size} steps passed (${EXPECTED.length} expected)`);
console.log(failed.length ? "Lanterel OS session test: FAIL" : "Lanterel OS session test: PASS");
process.exit(failed.length ? 1 : 0);
