// Writes the TPM vendor trust store the production verifier checks EK
// certificates against (server/tpm-roots, ek.ts), from Microsoft's
// TrustedTpm.cab: the TPM vendors' EK root and intermediate certificates that
// Windows itself trusts, which Microsoft collects from each vendor.
//
//   curl -L -o TrustedTpm.cab https://go.microsoft.com/fwlink/?linkid=2097925
//   node server/scripts/tpm-roots.mjs TrustedTpm.cab
//
// It also takes the roots that vendors publish but the cab lacks (EXTRA_ROOTS
// below, each pinned by its SHA-256), from the vendor over HTTPS.
//
// Needs cabextract and network access. It rewrites server/tpm-roots/firmware/*.pem,
// server/tpm-roots/discrete/*.pem and server/tpm-roots/manifest.json, and
// prints what changed against the store already there: a person reviews that
// diff, and the fingerprints in it, before committing.
//
// What is taken, by the cab's vendor folder:
//
//   firmware  AMD (fTPM and AMD's Pluton), Intel (PTT), with AMD's two fTPM
//             roots (AMDTPM, RSA and ECC) from ftpm.amd.com: the cab has the
//             intermediates they sign for each CPU family but not them
//   discrete  Infineon, STMicro, Nuvoton, NationZ, Atmel
//
// and left out: Microsoft/ (the CAs that issue Windows' AIK certificates under
// Microsoft TPM Root Certificate Authority 2014, not EK certificates: an AIK
// certificate must never pass for an EK's), QC/ (Qualcomm's Arm SoCs, which
// Swiff OS does not run on, with the same Microsoft root). Within the vendors'
// folders it leaves out every certificate OpenSSL will not parse (some old ones
// are not DER), every one that is not a CA, has expired, or is not yet valid,
// and every intermediate that does not chain to a root kept here.

import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "tpm-roots");
const SOURCE = "https://go.microsoft.com/fwlink/?linkid=2097925";

/** The cab's vendor folders this store takes, and the kind of TPM their roots certify. */
const VENDORS = [
  { folder: "AMD", file: "amd", kind: "firmware" },
  { folder: "Intel", file: "intel", kind: "firmware" },
  { folder: "Infineon", file: "infineon", kind: "discrete" },
  { folder: "STMicro", file: "stmicro", kind: "discrete" },
  { folder: "Nuvoton", file: "nuvoton", kind: "discrete" },
  { folder: "NationZ", file: "nationz", kind: "discrete" },
  { folder: "Atmel", file: "atmel", kind: "discrete" },
];

/**
 * Roots a vendor publishes that the cab lacks, pinned. One is kept only when it
 * signed an intermediate in the cab, which is what vouches for it.
 */
const EXTRA_ROOTS = [
  {
    folder: "AMD",
    url: "https://ftpm.amd.com/pki/aia/264D39A23CEB5D5B49D610044EEBD121",
    sha256: "67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1",
  },
  {
    folder: "AMD",
    url: "https://ftpm.amd.com/pki/aia/23452201D41C5AB064032BD23F158FEF",
    sha256: "14aac9fd58471a612afd75d8c0955daf99f091b1863702f9e0d4113faf234f9d",
  },
];

const die = (message) => {
  console.error(`tpm-roots: ${message}`);
  process.exit(1);
};

const cab = process.argv[2];
if (process.argv.length !== 3 || !cab) die("usage: node server/scripts/tpm-roots.mjs <TrustedTpm.cab>");
if (!existsSync(cab)) die(`${cab} does not exist`);
const cabBytes = readFileSync(cab);
const dir = mkdtempSync(join(tmpdir(), "tpm-roots-"));
try {
  execFileSync("cabextract", ["-q", "-d", dir, cab], { stdio: ["ignore", "ignore", "inherit"] });
} catch (error) {
  rmSync(dir, { recursive: true, force: true });
  die(error.code === "ENOENT" ? "cabextract not found" : `cabextract failed: ${error.message}`);
}

const now = Date.now();
const extra = [];
for (const root of EXTRA_ROOTS) {
  const response = await fetch(root.url).catch((error) => die(`${root.url}: ${error.message}`));
  if (!response.ok) die(`${root.url}: HTTP ${response.status}`);
  const der = Buffer.from(await response.arrayBuffer());
  const got = createHash("sha256").update(der).digest("hex");
  if (got !== root.sha256) die(`${root.url} is ${got}, not the pinned ${root.sha256}`);
  extra.push({ ...root, cert: new X509Certificate(der) });
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const oneLine = (name) => name.replace(/\n/g, ", ");
const inDate = (cert) => Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);

/** Every certificate in `file`, as PEM (one or more) or DER, or why it is not one. */
function read(file) {
  const data = readFileSync(file);
  const pems = data.toString("latin1").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  try {
    return pems ? pems.map((pem) => new X509Certificate(pem)) : [new X509Certificate(data)];
  } catch {
    return "not a certificate OpenSSL parses";
  }
}

const selfSigned = (cert) => {
  try {
    return cert.checkIssued(cert) && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
};
const issuedBy = (cert, issuer) => {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

const manifest = {
  source: SOURCE,
  cabSha256: sha256(cabBytes),
  cabVersion: (() => {
    try {
      return readFileSync(join(dir, "version.txt"), "utf8").split(/\r?\n/)[1]?.trim() ?? null;
    } catch {
      return null;
    }
  })(),
  generated: new Date(now).toISOString(),
  vendors: [],
  left: [],
};

for (const { folder, file, kind } of VENDORS) {
  /** Certificates by fingerprint, so one in two files is kept once. */
  const found = new Map();
  for (const sub of ["RootCA", "IntermediateCA"]) {
    let names;
    try {
      names = readdirSync(join(dir, folder, sub)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = `${folder}/${sub}/${name}`;
      if (!/\.(cer|crt|der|pem)$/i.test(name)) continue;
      const certs = read(join(dir, folder, sub, name));
      if (typeof certs === "string") {
        manifest.left.push({ file: path, why: certs });
        continue;
      }
      for (const cert of certs) {
        const fingerprint = sha256(cert.raw);
        if (found.has(fingerprint)) continue;
        const why = !cert.ca
          ? "not a CA"
          : !inDate(cert)
            ? `not valid now (${cert.validFrom} to ${cert.validTo})`
            : null;
        if (why) {
          manifest.left.push({ file: path, subject: oneLine(cert.subject), sha256: fingerprint, why });
          continue;
        }
        found.set(fingerprint, { cert, file: path, root: selfSigned(cert) });
      }
    }
  }
  const vouched = (cert) => [...found.values()].some((entry) => !entry.root && issuedBy(entry.cert, cert));
  for (const root of extra.filter((root) => root.folder === folder)) {
    if (!selfSigned(root.cert) || !vouched(root.cert))
      die(`${root.url} signed no intermediate in ${folder}/`);
    found.set(root.sha256, { cert: root.cert, file: root.url, root: true });
  }
  const all = [...found.values()];
  const roots = all.filter((entry) => entry.root);
  if (!roots.length) die(`${folder} has no root that is valid now`);
  // Keep the intermediates that reach a root here, through each other.
  const kept = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of all) {
      if (kept.has(entry)) continue;
      if ([...kept].some((issuer) => issuedBy(entry.cert, issuer.cert))) {
        kept.add(entry);
        grew = true;
      }
    }
  }
  for (const entry of all) {
    if (!kept.has(entry)) {
      manifest.left.push({
        file: entry.file,
        subject: oneLine(entry.cert.subject),
        sha256: sha256(entry.cert.raw),
        why: "does not chain to a root kept here",
      });
    }
  }
  const certs = all
    .filter((entry) => kept.has(entry))
    .sort((a, b) => Number(b.root) - Number(a.root) || a.file.localeCompare(b.file));
  const pem = certs
    .map(({ cert, file: from, root }) =>
      [
        `# ${root ? "root" : "intermediate"}: ${oneLine(cert.subject)}`,
        `# issuer: ${oneLine(cert.issuer)}`,
        `# valid: ${cert.validFrom} to ${cert.validTo}`,
        `# sha256: ${sha256(cert.raw)}`,
        `# from: ${from.startsWith("https:") ? from : `TrustedTpm.cab ${from}`}`,
        cert.toString().trim(),
        "",
      ].join("\n"),
    )
    .join("\n");
  mkdirSync(join(OUT, kind), { recursive: true });
  writeFileSync(
    join(OUT, kind, `${file}.pem`),
    `# ${folder} TPM EK certificate authorities (${kind} TPMs), from Microsoft's TrustedTpm.cab:\n` +
      `# written by server/scripts/tpm-roots.mjs, see server/tpm-roots/README.md.\n\n${pem}`,
  );
  manifest.vendors.push({
    vendor: folder,
    kind,
    file: `${kind}/${file}.pem`,
    certificates: certs.map(({ cert, file: from, root }) => ({
      role: root ? "root" : "intermediate",
      subject: oneLine(cert.subject),
      notAfter: new Date(cert.validTo).toISOString(),
      sha256: sha256(cert.raw),
      from,
    })),
  });
}
manifest.left.sort((a, b) => a.file.localeCompare(b.file));

const manifestPath = join(OUT, "manifest.json");
const before = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(dir, { recursive: true, force: true });

const fingerprints = (m) =>
  new Map(
    (m?.vendors ?? []).flatMap((v) =>
      v.certificates.map((c) => [c.sha256, `${v.vendor} ${c.role}: ${c.subject}`]),
    ),
  );
const was = fingerprints(before);
const is = fingerprints(manifest);
for (const [fingerprint, what] of is) if (!was.has(fingerprint)) console.log(`+ ${fingerprint} ${what}`);
for (const [fingerprint, what] of was) if (!is.has(fingerprint)) console.log(`- ${fingerprint} ${what}`);
for (const vendor of manifest.vendors) {
  const roots = vendor.certificates.filter((c) => c.role === "root").length;
  console.log(`${vendor.file}: ${roots} roots, ${vendor.certificates.length - roots} intermediates`);
}
console.log(
  `left out: ${manifest.left.length} (manifest.json "left"); cab ${manifest.cabVersion}, sha256 ${manifest.cabSha256}`,
);
console.log(`from ${basename(cab)}: review the diff of server/tpm-roots before committing it.`);
