// The rental-mode session test, on the host side (session-test.sh runs it in a
// network namespace of its own). It plays the platform, the owner and a renter
// around a VM running the session test build of the image:
//
//   1. the platform: the real server, built (`npm run build`), with its
//      production TPM attestation verifier (ATTESTATION_VERIFIER=tpm), and a
//      TURN relay (coturn). Both have addresses that look public to the VM
//      (198.51.100.10 and .20, TEST-NET-2), so the image's firewall lets the VM
//      reach them as it would the internet. The TPM's vendor is a throwaway
//      local CA (swtpm_setup), and the boot policy is this build's, signed with
//      a throwaway key: PCR 11 as systemd-measure predicts it for the built UKI
//      (session-test.sh), PCRs 12 and 13 empty, and the boot applications and
//      Secure Boot authorities of the VM's first boot (its event log, read off
//      the serial console before the server starts), as the release step lists
//      a release's own.
//   2. the owner: offers the PC with the machine key and registers its TPM's
//      EK certificate, as their app does before the PC restarts into rental
//      mode, and hands the VM swiff-hostd's config on a fixture disk, as their
//      app will.
//   3. the VM: OVMF with Secure Boot and a software TPM manufactured with an EK
//      certificate. swiff-hostd attests with the image's attestation client
//      (swiff-attest: EK, AK, credential activation, a quote of PCRs 0-7 and
//      11-13 with the event log), opens its persistent state (a disk of its own
//      here) with the key share the server releases to that attested boot, and
//      offers the PC.
//   4. a renter: headless Chromium on the hosted site, signed in, who holds
//      Launch on the PC, sees Steam's sign-in code on Ignition, gets the game
//      once Steam signs in, plays it on the path ICE picks (both seats hold a
//      relay allocation; SWIFF_SESSION_RELAY_ONLY=1 leaves only the relay),
//      reloads and reconnects, and ends the session.
//   5. the restart: swiff-hostd restarts the PC clean, and in the next boot
//      attests again, opens the same state and offers the PC again.
//   6. a tampered boot: the PC is powered off and booted with a kernel command
//      line from outside the signed UKI (an SMBIOS string systemd-stub takes
//      and measures into PCR 12). The server refuses its attestation, so it
//      gets no state key and is never offered.
//
// SWIFF_SESSION_NO_IOMMU=1 boots the VM without its virtual IOMMU instead, and
// stops after the owner's steps: the boot must not reach `ready` (the image's
// swiff-dmaguard.service fails, so systemd-pcrphase.service never extends it
// into PCR 11), and the PC gets no state key and is never offered.
//
// Every step is one line, PASS or FAIL, with what the VM reported on its serial
// console (sessiontest-monitor, swiff-hostd's and the streamer's logs). The run
// passes only when every expected step passed. A stand-in Steam (no account,
// no network), a test picture in gamescope's place (no GPU) and a software TPM
// are the only parts not as on a real PC; see sessiontest/.
//
//   node session-harness.mjs --run <dir> --image <swiffos-sessiontest.raw>
//
// Needs TURNSERVER (coturn's turnserver), Playwright's Chromium
// (PLAYWRIGHT_BROWSERS_PATH), swtpm_setup and swtpm_localca, as session-test.sh
// checks, and SWIFF_SESSION_PCR11, the PCR 11 it predicts for the image's UKI.

import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
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
/** SWIFF_SESSION_NO_IOMMU=1: the VM has no IOMMU, so it must never reach `ready` or be offered. */
const NO_IOMMU = process.env.SWIFF_SESSION_NO_IOMMU === "1";
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

/** PCR 11 once the image's UKI has booted to `ready`, as systemd-measure predicts it (session-test.sh). */
const PCR11 = process.env.SWIFF_SESSION_PCR11 ?? "";
/** What the tampered boot takes from outside its signed UKI: a kernel command line, by SMBIOS. */
const TAMPER = "io.systemd.stub.kernel-cmdline-extra=lanterel.tampered=1";
const ZERO = "0".repeat(64);

const OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd";
const OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.fd";

// Every step the run must pass: the VM's, per boot, and the harness's own.
const EXPECTED = NO_IOMMU
  ? [
      "the release's boot policy, signed",
      "the owner registers the PC's EK certificate",
      "boot1/secure-boot",
      "boot1/root-is-verity",
      "boot1/hostd-active",
      "the boot without an IOMMU does not reach ready",
      "the boot without an IOMMU gets no state key and is not offered",
    ]
  : [
      "the release's boot policy, signed",
      "the owner registers the PC's EK certificate",
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
      "a tampered boot is refused attestation",
      "the tampered boot gets no state key and is not offered",
    ];

const results = new Map();
const started = Date.now();
/** Seconds since the harness started, for each step's line. */
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
/** Records one step, PASS or FAIL, and prints it; a step that passed stays passed. */
function record(name, ok, detail = "") {
  if (results.has(name) && results.get(name).ok) return;
  const safe = redact(detail);
  results.set(name, { ok, detail: safe });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${safe ? `  (${safe})` : ""}  [${elapsed()}]`);
}
/** Resolves after `ms`. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `check` every 250 ms and resolves with its first truthy value; rejects, naming `what`, after `ms`. */
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

/** A system tool's path, which may be in /usr/sbin, outside this user's PATH. */
const sbin = (tool) => ["/usr/sbin", "/sbin", "/usr/bin"].map((d) => join(d, tool)).find(existsSync) ?? tool;

/** Writes the run's disks: the image's copy, OVMF's variables, and the fixture, key and state disks. */
function prepare() {
  // The fixture disk carries the machine key, the others the VM's state:
  // everything the run writes is this user's alone.
  process.umask(0o077);
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(join(RUN, "fixtures", "qr"), { recursive: true, mode: 0o700 });
  chmodSync(RUN, 0o700);
  mkdirSync(join(RUN, "tpm"));
  manufactureTpm();
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
  chmodSync(join(RUN, "fixtures.img"), 0o600);
  rmSync(fixtures, { recursive: true });
  execFileSync(mkfs, ["-q", "-L", "SWIFFKEEP", join(RUN, "keep.img"), "16M"]);
  // Raw: swiff-hostd formats it as LUKS2 itself the first time the server has no key share for it.
  writeFileSync(join(RUN, "state.img"), "");
  execFileSync("truncate", ["-s", "64M", join(RUN, "state.img")]);
  // The build stays as it is: the VM writes to an overlay of it.
  const overlay = ["-f", "qcow2", "-b", IMAGE, "-F", "raw"];
  execFileSync("qemu-img", ["create", "-q", ...overlay, join(RUN, "disk.qcow2")]);
  copyFileSync(OVMF_VARS, join(RUN, "vars.fd"));
}

/**
 * Manufactures the VM's TPM as its maker would: swtpm_setup makes its EK
 * (RSA 2048, TCG template L-1) and has a throwaway local CA, the server's only
 * trusted TPM vendor, certify it. The CA's certificates go to roots/firmware.
 */
function manufactureTpm() {
  const ca = join(RUN, "tpm-ca");
  mkdirSync(ca);
  writeFileSync(
    join(ca, "swtpm-localca.conf"),
    `statedir = ${ca}\nsigningkey = ${ca}/signkey.pem\nissuercert = ${ca}/issuercert.pem\ncertserial = ${ca}/certserial\n`,
  );
  writeFileSync(
    join(ca, "swtpm-localca.options"),
    "--platform-manufacturer Lanterel\n--platform-version 2.1\n--platform-model session-vm\n",
  );
  const localca = execFileSync("sh", ["-c", "command -v swtpm_localca"]).toString().trim();
  writeFileSync(
    join(ca, "swtpm_setup.conf"),
    `create_certs_tool = ${localca}\ncreate_certs_tool_config = ${ca}/swtpm-localca.conf\ncreate_certs_tool_options = ${ca}/swtpm-localca.options\n`,
  );
  mkdirSync(join(RUN, "ek"));
  execFileSync(
    "swtpm_setup",
    [
      ...[
        "--tpm2",
        "--tpmstate",
        join(RUN, "tpm"),
        "--create-ek-cert",
        "--config",
        join(ca, "swtpm_setup.conf"),
      ],
      ...["--pcr-banks", "sha256", "--write-ek-cert-files", join(RUN, "ek")],
    ],
    { stdio: "ignore" },
  );
  mkdirSync(join(RUN, "roots", "firmware"), { recursive: true });
  copyFileSync(join(ca, "swtpm-localca-rootca-cert.pem"), join(RUN, "roots", "firmware", "root.pem"));
  copyFileSync(join(ca, "issuercert.pem"), join(RUN, "roots", "firmware", "issuer.pem"));
}

/**
 * The boot policy the server trusts: this build as one release, signed with a
 * throwaway key. PCR 11 is systemd-measure's prediction for the UKI; PCRs 12 and
 * 13 are empty, as a release takes nothing from outside its UKI; the boot
 * applications and Secure Boot authorities are those `eventLog`, the VM's first
 * boot, measured, read by the verifier's own event log reader.
 */
async function writeBootPolicy(eventLog) {
  const { bootFacts, parseEventLog } = await import(join(REPO, "server/dist/eventlog.js"));
  const { signBootPolicy } = await import(join(REPO, "server/dist/boot-policy.js"));
  if (!/^[0-9a-f]{64}$/.test(PCR11)) throw new Error("SWIFF_SESSION_PCR11 is not a predicted PCR 11");
  const facts = bootFacts(parseEventLog(eventLog));
  const apps = facts.bootApplications.map((app) => app.toString("hex"));
  const authorities = facts.secureBootAuthorities.map((a) => a.toString("hex"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const release = {
    name: "lanterel-os sessiontest",
    pcr11: [PCR11],
    pcr12: [ZERO],
    pcr13: [ZERO],
    bootApplications: apps,
    uki: apps.slice(-1),
    secureBootAuthorities: authorities,
    iommu: true,
  };
  writeFileSync(join(RUN, "policy.json"), signBootPolicy({ version: 1, releases: [release] }, privateKey));
  writeFileSync(join(RUN, "policy-key.pem"), publicKey.export({ format: "pem", type: "spki" }));
  record(
    "the release's boot policy, signed",
    apps.length > 0,
    `PCR 11 ${PCR11.slice(0, 12)}…, ${apps.length} boot application(s), ${authorities.length} Secure Boot authority(ies)`,
  );
}

// --- The platform: TURN relay and server ----------------------------------------------

const children = [];
/** Starts a process that the harness stops when it exits. */
function child(command, args, options = {}) {
  const proc = spawn(command, args, { stdio: "ignore", ...options });
  children.push(proc);
  return proc;
}

/** Which side each allocation the relay granted on a minted credential was for: never the username itself. */
const allocations = new Set();
/** Starts coturn on the relay's address and notes which seats it grants an allocation. */
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
  createReadStream(fifo, "utf8").on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const m = /user <\d+:[\w-]+-(renter|host)>: incoming packet ALLOCATE processed, success/.exec(line);
      if (m) allocations.add(m[1]);
    }
  });
}

/** Starts the built server and resolves once it answers /api/ping. */
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
      // The session test drives the paid marketplace (server/src/features.ts):
      // the wall at "/" and a stranger's PC.
      PAID_GAMING: "on",
      TURN_URLS: `turn:${TURN_IP}:3478`,
      TURN_SECRET,
      // The production verifier: a TPM quote of a signed release's boot.
      ATTESTATION_VERIFIER: "tpm",
      ATTESTATION_TPM_ROOTS: join(RUN, "roots"),
      ATTESTATION_POLICY: join(RUN, "policy.json"),
      ATTESTATION_POLICY_KEY: join(RUN, "policy-key.pem"),
      // The machine key still hosts: the agent hosts on its host certificate in a later stage.
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

/** The owner's app registers the TPM's EK certificate, as Windows reads it, with the machine key. */
async function ownerRegistersEk() {
  const certificate = readFileSync(join(RUN, "ek", "ek-rsa2048.crt")).toString("base64");
  const res = await fetch(`${ORIGIN}/api/machines/${MACHINE}/ek`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ certificate }),
  });
  record("the owner registers the PC's EK certificate", res.status === 204, `answered ${res.status}`);
}

// --- The VM --------------------------------------------------------------------------

const serial = join(RUN, "serial.log");
let boot = 0;
const vmLines = [];
/** The firmware's event log of each boot, as the VM reported it, and the parts of the one being reported. */
const eventLogs = new Map();
const eventLogParts = [];
/** Reads the serial console as it grows: the monitor's results by boot, and the agents' logs. */
function watchSerial() {
  let offset = 0;
  let rest = "";
  setInterval(() => {
    let text;
    try {
      const data = readFileSync(serial);
      // A new QEMU (the tampered boot's) starts the console file over.
      if (data.length < offset) {
        offset = 0;
        rest = "";
      }
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
      } else if (m[1] === "INFO" && m[2] === "eventlog-part") {
        eventLogParts.push(m[3]);
      } else if (m[1] === "INFO" && m[2] === "eventlog-end") {
        eventLogs.set(boot, Buffer.from(eventLogParts.splice(0).join(""), "base64"));
      } else if (m[1] === "INFO") {
        console.log(`info  boot${boot}/${m[2]} ${redact(m[3])}`);
      } else {
        record(`boot${boot}/${m[2]}`, m[1] === "PASS", m[3]);
      }
    }
  }, 300);
}
/** The first serial console line matching `pattern`, in boot `inBoot` when given. */
const seen = (pattern, inBoot) =>
  vmLines.find((l) => (inBoot === undefined || l.boot === inBoot) && pattern.test(l.line));
/** Waits up to `ms` for the VM to report step `name`, and records it failed when it never does or the VM stopped. */
const waitVm = (name, ms) =>
  until(() => results.get(name) ?? (vmStopped && { stopped: vmStopped }), name, ms).then(
    (r) => r.stopped && record(name, false, r.stopped),
    () => record(name, false, "never reported"),
  );

/** The running VM's QEMU (its vm-run.py) and swtpm. */
let vm = [];
/** Why the VM stopped on its own, when vm-run.py or QEMU failed: the VM's waits end with it. */
let vmStopped = null;
/**
 * Starts swtpm and QEMU: the image boots under OVMF with Secure Boot and the software TPM. `extra`: more QEMU arguments.
 * QEMU starts through vm-run.py, which waits for room among the PC's test VMs and stops it
 * when its console is silent for 10 minutes or it runs past an hour.
 */
function startVm(extra = []) {
  const tpm = join(RUN, "tpm");
  rmSync(`${tpm}/sock`, { force: true });
  const swtpm = child("swtpm", [
    ...["socket", "--tpm2", "--tpmstate", `dir=${tpm}`, "--ctrl", `type=unixio,path=${tpm}/sock`],
  ]);
  return until(() => existsSync(`${tpm}/sock`), "swtpm", 10_000).then(() => {
    const qemu = child(
      join(dirname(fileURLToPath(import.meta.url)), "vm-run.py"),
      [
        ...["--name", "session", "--timeout", "3600", "--stall", "600", "--progress", serial, "--"],
        "qemu-system-x86_64",
        ...[
          "-machine",
          "q35,smm=on,accel=kvm,kernel-irqchip=split",
          "-cpu",
          "host",
          "-smp",
          process.env.SWIFF_VM_CPUS ?? "4",
          "-m",
          "2048",
        ],
        ...["-global", "driver=cfi.pflash01,property=secure,value=on", "-global", "ICH9-LPC.disable_s3=1"],
        ...["-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${OVMF_CODE}`],
        ...["-drive", `if=pflash,format=raw,unit=1,file=${join(RUN, "vars.fd")}`],
        ...(NO_IOMMU ? [] : ["-device", "intel-iommu,intremap=on"]),
        ...["-chardev", `socket,id=chrtpm,path=${tpm}/sock`, "-tpmdev", "emulator,id=tpm0,chardev=chrtpm"],
        ...["-device", "tpm-crb,tpmdev=tpm0"],
        // QEMU's default cache: a cut power (powerOff) loses only what the guest had not flushed.
        ...["-drive", `if=none,id=os,format=qcow2,file=${join(RUN, "disk.qcow2")}`],
        ...["-device", "virtio-blk-pci,drive=os,bootindex=1"],
        ...["-drive", `if=none,id=fix,format=raw,readonly=on,file=${join(RUN, "fixtures.img")}`],
        ...["-device", "virtio-blk-pci,drive=fix"],
        ...["-drive", `if=none,id=keep,format=raw,file=${join(RUN, "keep.img")}`],
        ...["-device", "virtio-blk-pci,drive=keep"],
        ...["-drive", `if=none,id=state,format=raw,file=${join(RUN, "state.img")}`],
        ...["-device", "virtio-blk-pci,drive=state,serial=swiffstate"],
        ...["-netdev", "user,id=n0", "-device", "virtio-net-pci,netdev=n0", "-device", "virtio-rng-pci"],
        ...["-display", "none", "-vga", "none", "-monitor", "none", "-serial", `file:${serial}`],
        ...extra,
      ],
      { stdio: ["ignore", "ignore", openSync(join(RUN, "qemu.log"), "a")] },
    );
    qemu.on("exit", (code, signal) => {
      // vm-run.py stopped it (no room, a hang, the PC out of memory), QEMU failed, or the runner
      // was killed: say why now. powerOff's cut ends it with 0.
      if (!code && !signal) return;
      const how = code ? `exit ${code}` : signal;
      vmStopped = `the VM stopped (${how}): ${readFileSync(join(RUN, "qemu.log"), "utf8").trim()}`;
      console.log(`----  ${vmStopped}`);
    });
    vm = [qemu, swtpm];
    return qemu;
  });
}

/**
 * Cuts the VM's power: QEMU and its TPM stop at once, as at the wall. vm-run.py takes SIGUSR1
 * as the cut: it kills QEMU with SIGKILL and exits once QEMU has.
 */
async function powerOff() {
  for (const [i, proc] of vm.entries()) {
    if (proc.exitCode !== null || proc.signalCode !== null) continue;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill(i === 0 ? "SIGUSR1" : "SIGKILL");
    await exited;
  }
  vmStopped = null;
}

// --- The renter --------------------------------------------------------------------------

/** In the renter's page: each peer connection's state and its candidate pairs' types, for a stream that never came. */
async function iceReport() {
  const out = [];
  for (const pc of window.__swiffPeers ?? []) {
    const stats = await pc.getStats();
    const side = (id) => stats.get(id)?.candidateType;
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

/** In the renter's page: the candidate types of the pair carrying its live stream, never their addresses. */
async function selectedPair() {
  for (const pc of [...(window.__swiffPeers ?? [])].reverse()) {
    if (pc.connectionState !== "connected") continue;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) continue;
    const side = (id) => stats.get(id)?.candidateType;
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

/** The renter's visit to the hosted site, from the wall to the end of the session, one step at a time. */
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
    // The streamer's encoder check can take most of a minute on a slow VM.
    const encoding = await until(
      () => seen(/\[swiff-streamer\] encoding with (\S+)/),
      "the streamer's encoder",
      90_000,
    ).catch(() => null);
    record(
      "streamer encodes",
      Boolean(encoding),
      encoding?.line.replace(/^.*encoding with/, "encoding with"),
    );
    const registered = await until(
      () => seen(/registered; waiting for the renter/),
      "the streamer's registration",
      90_000,
    ).catch(() => null);
    record("streamer registers with its session key", Boolean(registered));

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

/**
 * The PC powered off and booted with a kernel command line from outside its
 * signed UKI: systemd-stub measures it into PCR 12, which no release has.
 * Its attestation is refused, so the server keeps its state key back and the
 * PC is never offered.
 */
async function tamperedBoot() {
  await powerOff();
  const before = boot;
  await startVm(["-smbios", `type=11,value=${TAMPER}`]);
  console.log(`----  the VM is booting with ${TAMPER}  [${elapsed()}]`);
  const tampered = before + 1;
  // The client's refusal, as swiff-hostd logs it, with the verifier's reason
  // last. A try before systemd measured the `ready` phase into PCR 11 is
  // refused as unknown-boot-image first: the PCR 12 refusal comes on a later one.
  const refusal = await until(
    () => boot >= tampered && seen(/attest answered \d+ .*unknown-boot-extras/, tampered),
    "the tampered boot's refusal",
    600_000,
  ).catch(() => null);
  record(
    "a tampered boot is refused attestation",
    Boolean(refusal),
    refusal?.line.replace(/^.*swiff-attest: /, "") ??
      seen(/\[swiff-hostd\] not offered: /, tampered)?.line ??
      "no attestation reported",
  );
  // Long enough for the agent's next tries, which the server refuses the same way.
  await sleep(45_000);
  const offered = results.get(`boot${tampered}/hostd-offered`);
  const state = seen(/the persistent state is open/, tampered);
  record(
    "the tampered boot gets no state key and is not offered",
    Boolean(refusal) && !offered?.ok && !state && !seen(/hostd-phase offered/, tampered),
    `offered: ${offered?.ok ? "yes" : "no"}, state opened: ${state ? "yes" : "no"}`,
  );
}

/**
 * The boot without an IOMMU: swiff-dmaguard.service fails, so the boot never
 * reaches `ready` and its PCR 11 is no release's. The PC gets no state key
 * and is never offered.
 */
async function withoutIommu() {
  const ready = await until(
    () => seen(/SWIFF-SESSIONTEST INFO ready-phase /, 1),
    "the ready phase",
    300_000,
  ).catch(() => null);
  const phase = ready?.line.replace(/^.*ready-phase /, "");
  record(
    "the boot without an IOMMU does not reach ready",
    Boolean(phase) && !/^active\b/.test(phase),
    phase ?? "not reported",
  );
  // swiff-hostd's floor check refuses the PC; then a while longer, in which
  // nothing may offer it or open its state.
  const refusal = await until(
    () => seen(/\[swiff-hostd\] not offered: /, 1),
    "swiff-hostd's refusal",
    120_000,
  ).catch(() => null);
  await sleep(30_000);
  const offered = results.get("boot1/hostd-offered");
  const state = seen(/the persistent state is open/, 1);
  record(
    "the boot without an IOMMU gets no state key and is not offered",
    Boolean(ready) && Boolean(refusal) && !offered?.ok && !state && !seen(/hostd-phase offered/, 1),
    `${refusal?.line.replace(/^.*\[swiff-hostd\] /, "") ?? "no refusal logged"}; offered: ${offered?.ok ? "yes" : "no"}, state opened: ${state ? "yes" : "no"}`,
  );
}

// --- The run ------------------------------------------------------------------------------

/** Stops every process the harness started and deletes the fixture disk, which holds the machine key. */
function stopAll() {
  for (const proc of children) proc.kill();
  rmSync(join(RUN, "fixtures.img"), { force: true });
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

try {
  prepare();
  startRelay();
  watchSerial();
  await startVm();
  console.log(`----  the VM is starting; its console is in ${serial}`);
  // The release's policy names what the VM's boot measured: the server starts
  // once the VM reported it. swiff-hostd tries to attest meanwhile, and again
  // after 5, 15, 30 s ...
  await until(() => eventLogs.get(1), "the VM's event log", 600_000);
  await writeBootPolicy(eventLogs.get(1));
  await startServer();
  console.log(`----  the platform: server ${SERVER_IP}:${PORT}, TURN relay ${TURN_IP}:3478  [${elapsed()}]`);
  await ownerGoesLive();
  await ownerRegistersEk();

  if (NO_IOMMU) {
    await waitVm("boot1/hostd-active", 300_000);
    await withoutIommu();
  } else await waitVm("boot1/hostd-offered", 600_000);
  if (!NO_IOMMU && results.get("boot1/hostd-offered")?.ok) {
    await renter().catch((e) => record("renter", false, e.message));
    await until(() => seen(/\[swiff-hostd\] session \S+ is over/, 1), "the session's end", 60_000).catch(
      () => {},
    );
    const out = seen(/\[swiff-streamer\] the server put the streamer out/, 1);
    record(
      "streamer stops when the session ends",
      Boolean(seen(/\[swiff-hostd\] session \S+ is over/, 1)) && Boolean(out),
      out?.line.replace(/^.*\[swiff-streamer\] /, "") ?? "no stop line from the streamer",
    );
    await until(() => boot >= 2, "the restart", 180_000).catch(() => {});
    record(
      "hostd restarts the PC clean",
      boot >= 2 && Boolean(seen(/\[swiff-hostd\] restarting for a clean PC/, 1)),
    );
    if (boot >= 2) {
      await waitVm("boot2/hostd-offered", 600_000);
      // The VM reports these right after the offer, not before it.
      await waitVm("boot2/hostd-attested", 10_000);
      await waitVm("boot2/state-open", 10_000);
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
      await tamperedBoot();
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
