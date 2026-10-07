// The attestation client on a software TPM against the real server and its
// production verifier (ATTESTATION_VERIFIER=tpm): nothing recorded, nothing
// stood in for but the TPM's maker and the firmware.
//
// swtpm_setup manufactures the TPM with an RSA 2048 EK and an EK certificate
// from a throwaway local CA, which the server trusts as a TPM vendor. The test
// measures a synthetic boot into it (server/scripts/tpm-boot.mjs, the boot the
// verifier's own fixtures record), signs a boot policy for that release with a
// throwaway key, registers the EK as the owner's Windows does, and then the
// client attests: the host certificate it earns opens the state key.
//
// Skipped where swtpm is not installed (apt install swtpm swtpm-tools).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signBootPolicy } from "../../../server/src/boot-policy.ts";
import {
  bootApplications,
  bootEvents,
  eventLog,
  secureBootAuthorities,
  sha256,
} from "../../../server/scripts/tpm-boot.mjs";
import { AttestFailed, attestBoot } from "./attest.ts";
import { StateKeyRefused, stateKeyApi } from "./state-key.ts";
import { tcpTransport, Tpm, type Transport } from "./tpm.ts";

const has = (tool: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const SWTPM = has("swtpm") && has("swtpm_setup") && has("swtpm_localca") && has("swtpm_ioctl");

const PORT = 9300 + Math.floor(Math.random() * 400);
const TPM_PORT = 24000 + Math.floor(Math.random() * 400) * 2;
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;
const MACHINE = "attest-pc-1";
/** A machine whose owner never registered an EK. */
const UNREGISTERED = "attest-pc-2";
const MACHINE_KEY = "hostd-attest-machine-key";
const RSA_EK_CERT_NV = 0x01c00002;
const TPM_RH_OWNER = 0x40000001;

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SERVER_ENTRY = resolve(
  REPO_ROOT,
  "server",
  (JSON.parse(readFileSync(resolve(REPO_ROOT, "server/package.json"), "utf8")) as { main: string }).main,
);

/** The golden boot: the release's own, with nothing changed. */
const GOLDEN = {};
const ZERO = "0".repeat(64);

let work: string;
let swtpm: ChildProcess | undefined;
let server: ChildProcess | undefined;
let transport: Transport | undefined;
let tpm: Tpm;
let ekCertificate: Buffer;

/** The EK certificate swtpm_setup stored where the TCG's provisioning guidance puts it. */
async function readEkCertificate(): Promise<Buffer> {
  // A password session with an empty password.
  const pw = Buffer.from([0x40, 0x00, 0x00, 0x09, 0, 0, 1, 0, 0]);
  const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
  const pub = await tpm.run(0x169, { handles: [RSA_EK_CERT_NV] }); // TPM2_NV_ReadPublic
  pub.u16();
  pub.u32();
  pub.u16();
  pub.u32();
  pub.b2();
  const size = pub.u16();
  const out: Buffer[] = [];
  for (let offset = 0; offset < size; offset += 512) {
    const r = await tpm.run(0x14e, {
      handles: [TPM_RH_OWNER, RSA_EK_CERT_NV],
      auths: [pw],
      params: Buffer.concat([u16(Math.min(512, size - offset)), u16(offset)]),
    }); // TPM2_NV_Read
    r.u32();
    out.push(r.b2());
  }
  return Buffer.concat(out);
}

/** Manufacture a TPM in `dir` as swtpm_setup does: RSA 2048 EK, certified by the local CA in `ca`. */
function manufacture(dir: string, ca: string) {
  writeFileSync(
    join(ca, "swtpm-localca.conf"),
    `statedir = ${ca}\nsigningkey = ${ca}/signkey.pem\nissuercert = ${ca}/issuercert.pem\ncertserial = ${ca}/certserial\n`,
  );
  writeFileSync(
    join(ca, "swtpm-localca.options"),
    "--platform-manufacturer Swiff\n--platform-version 2.1\n--platform-model attest-test\n",
  );
  const localca = execFileSync("sh", ["-c", "command -v swtpm_localca"]).toString().trim();
  writeFileSync(
    join(ca, "swtpm_setup.conf"),
    `create_certs_tool = ${localca}\ncreate_certs_tool_config = ${ca}/swtpm-localca.conf\ncreate_certs_tool_options = ${ca}/swtpm-localca.options\n`,
  );
  execFileSync(
    "swtpm_setup",
    [
      "--tpm2",
      "--tpmstate",
      dir,
      "--create-ek-cert",
      "--config",
      join(ca, "swtpm_setup.conf"),
      "--overwrite",
      "--pcr-banks",
      "sha256",
    ],
    { stdio: "ignore" },
  );
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${MACHINE_KEY}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>),
  };
}

const attest = (machineId = MACHINE, log: Buffer = eventLog(GOLDEN)) =>
  attestBoot({ origin: HTTP_URL, machineId, tpm, eventLog: async () => log });

describe.skipIf(!SWTPM)("swiff-attest on a software TPM, against the server's TPM verifier", () => {
  beforeAll(async () => {
    expect(existsSync(SERVER_ENTRY), "the server is not built: run `npm run build -w @swiff/server`").toBe(
      true,
    );
    work = mkdtempSync(join(tmpdir(), "swiff-attest-test-"));
    const ca = join(work, "ca");
    const state = join(work, "tpm");
    mkdirSync(ca);
    mkdirSync(state);
    manufacture(state, ca);

    swtpm = spawn(
      "swtpm",
      [
        "socket",
        "--tpm2",
        "--tpmstate",
        `dir=${state}`,
        "--server",
        `type=tcp,port=${TPM_PORT},bindaddr=127.0.0.1`,
        "--ctrl",
        `type=tcp,port=${TPM_PORT + 1},bindaddr=127.0.0.1`,
        "--flags",
        "not-need-init,startup-clear",
      ],
      { stdio: "ignore" },
    );
    for (let tries = 0; !transport; tries++) {
      try {
        transport = await tcpTransport("127.0.0.1", TPM_PORT);
      } catch (error) {
        if (tries > 50) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    tpm = new Tpm(transport);
    ekCertificate = await readEkCertificate();

    // The firmware and systemd, booting the release.
    const { events, phases } = bootEvents(GOLDEN);
    for (const event of events) await tpm.extend(event.pcr, sha256(event.measured));
    for (const phase of phases) await tpm.extend(11, sha256(Buffer.from(phase)));
    const booted = await tpm.readPcrs([11, 12, 13]);
    expect([booted[12], booted[13]]).toEqual([ZERO, ZERO]);

    // The release step: the boot policy for that release, signed with a throwaway key.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const policy = signBootPolicy(
      {
        version: 1,
        releases: [
          {
            name: "lanterel-os attest-test",
            pcr11: [booted[11]],
            pcr12: [ZERO],
            pcr13: [ZERO],
            bootApplications: bootApplications(GOLDEN),
            uki: bootApplications(GOLDEN).slice(-1),
            secureBootAuthorities: secureBootAuthorities(GOLDEN),
            iommu: true,
          },
        ],
      },
      privateKey,
    );
    writeFileSync(join(work, "policy.json"), policy);
    writeFileSync(join(work, "policy-key.pem"), publicKey.export({ format: "pem", type: "spki" }));
    // The local CA stands in for a firmware TPM's vendor.
    mkdirSync(join(work, "roots", "firmware"), { recursive: true });
    writeFileSync(
      join(work, "roots", "firmware", "root.pem"),
      readFileSync(join(ca, "swtpm-localca-rootca-cert.pem")),
    );
    writeFileSync(join(work, "roots", "firmware", "issuer.pem"), readFileSync(join(ca, "issuercert.pem")));

    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: resolve(REPO_ROOT, "server"),
      env: {
        ...process.env,
        PORT: String(PORT),
        ROOM_SECRET: "hostd-attest-room-secret-long-enough-for-it",
        SESSION_SECRET: "hostd-attest-session-secret-long-enough",
        MACHINE_KEYS: [MACHINE, UNREGISTERED]
          .map((id) => `${id}:${createHash("sha256").update(MACHINE_KEY).digest("hex")}`)
          .join(","),
        HOSTING_ATTESTATION: "required",
        ATTESTATION_VERIFIER: "tpm",
        ATTESTATION_TPM_ROOTS: join(work, "roots"),
        ATTESTATION_POLICY: join(work, "policy.json"),
        ATTESTATION_POLICY_KEY: join(work, "policy-key.pem"),
        STATE_KEY_SECRET: "hostd-attest-state-key-secret-long-enough",
        DATABASE_URL: "",
        SWIFF_PLAYABILITY: "off",
      },
      stdio: "ignore",
    });
    // Without DATABASE_URL the server first boots an in-memory Postgres: slow on a loaded machine.
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
      try {
        if ((await fetch(`${HTTP_URL}/api/ping`)).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the server did not start");
  });

  afterAll(() => {
    server?.kill();
    transport?.close();
    swtpm?.kill();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("refuses a PC whose owner registered no EK", async () => {
    await expect(attest(UNREGISTERED)).rejects.toThrow(/attest-activation answered 403 .*unknown-ek/);
  });

  it("attests the release's boot once the owner registered the EK, and the host certificate opens the state key", async () => {
    // The owner's Windows, in rental-mode setup (desktop/rental.cjs).
    expect(
      await call("PUT", `/api/machines/${MACHINE}/ek`, { certificate: ekCertificate.toString("base64") }),
    ).toEqual({ status: 204, body: null });

    const grant = await attest();
    expect(grant.tier).toBe("attested");
    expect(typeof grant.hostCert).toBe("string");

    // swiff-hostd's own state-key calls: the first boot has no V yet, and makes one.
    const api = stateKeyApi(SERVER_URL, MACHINE);
    const missing = await api.release(grant.hostCert).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(StateKeyRefused);
    expect((missing as StateKeyRefused).code).toBe("no-state-key");
    const made = await api.replace(grant.hostCert);
    expect(Buffer.from(made.share, "base64")).toHaveLength(32);

    // Attested again in the same boot, the PC gets the same V.
    const again = await attest();
    expect(await api.release(again.hostCert)).toEqual(made);
  });

  it("refuses an event log that is not the firmware's", async () => {
    await expect(attest(MACHINE, eventLog({ firmware: "firmware-v2" }))).rejects.toThrow(
      /attest answered 403 .*event-log-mismatch/,
    );
  });

  it("refuses a boot whose PCR 11 is no release's", async () => {
    // Something extended PCR 11 after the release's boot: not what the policy lists.
    await tpm.extend(11, sha256(Buffer.from("not the release")));
    const refused = attest().catch((error: unknown) => error);
    await expect(refused).resolves.toBeInstanceOf(AttestFailed);
    await expect(refused).resolves.toHaveProperty("message", expect.stringMatching(/unknown-boot-image/));
  });
});
