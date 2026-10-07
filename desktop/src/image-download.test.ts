// @vitest-environment node
// Lanterel OS's download (image-download.cjs): a set packed as the release
// packs it, signed with a throwaway key the test trusts, served from a local
// HTTP server. Nothing is kept unless that key signed the manifest and every
// part and file matches it, an interrupted part carries on from where it
// stopped, and the whole set lands where the installer reads it.

import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { downloadSet, packSet, PARTS_DIR, sourceOf, type ImageProgress } from "../image-download.cjs";
import { MANIFEST, readImageSet, SIGNATURE, type Trust } from "../image-set.cjs";
import { splitFile, SWIFF_OS } from "../rental.cjs";

const ID = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
const CERT = Buffer.from("not really a certificate, but the bytes the set carries");
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** Small parts, so every file comes in more than one. */
const PART = 256 * 1024;

/** SHA-256 of a file, read in blocks. */
async function fileSha(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * A full-size image set in `dir` (sparse: a few bytes in each file, the rest
 * empty), packed as the release packs it and signed with `key`.
 */
async function releaseSet(dir: string, key: KeyObject) {
  fs.mkdirSync(dir, { recursive: true });
  const layout = SWIFF_OS.partitions.map((p, i) => ({ ...p, id: ID(i), name: `part${i}` }));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const p of layout.filter((p) => p.split)) {
    const name = splitFile(p.split!);
    const file = path.join(dir, name);
    const fd = fs.openSync(file, "w");
    // Something to find at the start, part way and at the end; empty space between.
    fs.writeSync(fd, Buffer.from(`${name} start`), 0, undefined, 0);
    fs.writeSync(fd, Buffer.from(`${name} middle`), 0, undefined, Math.floor(p.bytes / 3));
    fs.writeSync(fd, Buffer.from("end!"), 0, undefined, p.bytes - 4);
    fs.closeSync(fd);
    files[name] = { bytes: p.bytes, sha256: await fileSha(file) };
  }
  fs.writeFileSync(path.join(dir, "swiffos-key.cer"), CERT);
  files["swiffos-key.cer"] = { bytes: CERT.length, sha256: sha256(CERT) };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ version: SWIFF_OS.version, layout, files }));
  await packSet(dir, PART, 1);
  const manifest = fs.readFileSync(path.join(dir, MANIFEST));
  fs.writeFileSync(path.join(dir, SIGNATURE), sign(null, manifest, key));
  return { files, manifest: JSON.parse(manifest.toString("utf8")) };
}

/** What the server does to a request: serve it, or answer it some other way. */
type Fault = (name: string, req: http.IncomingMessage, res: http.ServerResponse) => boolean;

/** Serve `dir`'s manifest and signature and its download/ parts, as a release does, Range requests too. */
function serve(dir: string) {
  const state: { fault: Fault | null; asked: { name: string; range: string | null }[] } = {
    fault: null,
    asked: [],
  };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url!.split("/").pop()!);
    state.asked.push({ name, range: req.headers.range ?? null });
    if (state.fault?.(name, req, res)) return;
    const file = [path.join(dir, name), path.join(dir, "download", name)].find(
      (f) => /^[\w.+-]+$/.test(name) && fs.existsSync(f),
    );
    if (!file) return res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, {
      "content-length": size - from,
      ...(range ? { "content-range": `bytes ${from}-${size - 1}/${size}` } : {}),
    });
    fs.createReadStream(file, { start: from }).pipe(res);
  });
  return new Promise<{ url: string; state: typeof state; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/swiffos-${SWIFF_OS.version}/`,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    ),
  );
}

describe("Lanterel OS's download", () => {
  let tmp: string;
  let release: string;
  let key: KeyObject;
  let trust: Trust[];
  let packed: Awaited<ReturnType<typeof releaseSet>>;
  let server: Awaited<ReturnType<typeof serve>>;
  let dir: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swiff-image-download-"));
    release = path.join(tmp, "release");
    const pair = generateKeyPairSync("ed25519");
    key = pair.privateKey;
    trust = [
      {
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        certSha256: sha256(CERT),
      },
    ];
    packed = await releaseSet(release, key);
    server = await serve(release);
  }, 240_000);
  afterAll(async () => {
    await server?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, "host-"));
    server.state.fault = null;
    server.state.asked = [];
  });

  it("packs each file into parts under the part size, listed in the manifest the signature covers", () => {
    const listed = packed.manifest.download;
    expect(listed.compression).toBe("gzip");
    expect(Object.keys(listed.files).sort()).toEqual(Object.keys(packed.files).sort());
    const root = listed.files[splitFile("root-x86-64")].parts;
    expect(root.length).toBeGreaterThan(1);
    for (const { parts } of Object.values(listed.files) as {
      parts: { name: string; bytes: number; sha256: string }[];
    }[])
      for (const p of parts) {
        expect(p.bytes).toBeLessThanOrEqual(PART);
        const bytes = fs.readFileSync(path.join(release, "download", p.name));
        expect(bytes.length).toBe(p.bytes);
        expect(sha256(bytes)).toBe(p.sha256);
      }
    // 8 GiB of mostly empty root packs to a few megabytes.
    expect(root.reduce((n: number, p: { bytes: number }) => n + p.bytes, 0)).toBeLessThan(64 * 1024 * 1024);
  });

  it("downloads, checks and unpacks the whole set where the installer reads it", async () => {
    const progress: ImageProgress[] = [];
    const version = await downloadSet({ url: server.url, dir, trust, onProgress: (p) => progress.push(p) });
    expect(version).toBe(SWIFF_OS.version);
    const set = readImageSet(dir, { trust });
    for (const [name, f] of Object.entries(packed.files)) {
      expect(fs.statSync(path.join(dir, name)).size).toBe(f.bytes);
      expect(await fileSha(path.join(dir, name))).toBe(f.sha256);
      expect(set.files[name]).toEqual(f);
    }
    expect(fs.existsSync(path.join(dir, PARTS_DIR))).toBe(false);
    // Honest progress: it ends at its total, and never goes past it.
    const download = progress.filter((p) => p.phase === "download");
    const unpack = progress.filter((p) => p.phase === "unpack");
    expect(download.at(-1)!.done).toBe(download.at(-1)!.total);
    expect(unpack.at(-1)!.done).toBe(unpack.at(-1)!.total);
    expect(unpack.at(-1)!.total).toBe(Object.values(packed.files).reduce((n, f) => n + f.bytes, 0));
    expect(progress.every((p) => p.done <= p.total || p.phase === "check")).toBe(true);
  }, 240_000);

  it("refuses a manifest no trusted key signed, and fetches no part of it", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(
      downloadSet({ url: server.url, dir, trust: [{ publicKey: other, certSha256: sha256(CERT) }] }),
    ).rejects.toThrow(/didn't pass the check \(Lanterel did not sign this image set\)/);
    expect(server.state.asked.map((a) => a.name)).toEqual([MANIFEST, SIGNATURE]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a manifest changed after it was signed", async () => {
    server.state.fault = (name, _req, res) => {
      if (name !== MANIFEST) return false;
      const changed = { ...packed.manifest, version: "9.9.9" };
      res.writeHead(200).end(JSON.stringify(changed));
      return true;
    };
    await expect(downloadSet({ url: server.url, dir, trust })).rejects.toThrow(/didn't pass the check/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a part that is not the one signed, keeps nothing of it, and sets nothing up", async () => {
    const first = packed.manifest.download.files[splitFile("esp")].parts[0];
    server.state.fault = (name, _req, res) => {
      if (name !== first.name) return false;
      res.writeHead(200).end(Buffer.alloc(first.bytes, 7));
      return true;
    };
    await expect(downloadSet({ url: server.url, dir, trust })).rejects.toThrow(
      /didn't match what Lanterel signed, so nothing was installed from it/,
    );
    expect(fs.existsSync(path.join(dir, PARTS_DIR, first.name))).toBe(false);
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(false);
    expect(fs.existsSync(path.join(dir, splitFile("esp")))).toBe(false);
  });

  it("refuses to start without room on the disk", async () => {
    await expect(downloadSet({ url: server.url, dir, trust, free: () => 1024 ** 3 })).rejects.toThrow(
      /needs [\d.]+ GB free .* and it has 1\.0 GB\. Free up space/,
    );
    expect(server.state.asked.map((a) => a.name)).toEqual([MANIFEST, SIGNATURE]);
  });

  it("carries on an interrupted part from where it stopped", async () => {
    const first = packed.manifest.download.files[splitFile("esp")].parts[0];
    const cut = Math.floor(first.bytes / 2);
    let cutOnce = true;
    server.state.fault = (name, _req, res) => {
      if (name !== first.name || !cutOnce) return false;
      cutOnce = false;
      // Half the part, then the connection drops.
      res.writeHead(200, { "content-length": first.bytes });
      res.write(fs.readFileSync(path.join(release, "download", first.name)).subarray(0, cut));
      setTimeout(() => res.destroy(), 50);
      return true;
    };
    await expect(downloadSet({ url: server.url, dir, trust })).rejects.toThrow(/carries on where it stopped/);
    expect(fs.statSync(path.join(dir, PARTS_DIR, first.name)).size).toBe(cut);

    // Stop again at the second file, to keep this quick: the first file is in by then.
    const root = packed.manifest.download.files[splitFile("root-x86-64")].parts[0];
    server.state.fault = (name, _req, res) => {
      if (name !== root.name) return false;
      res.writeHead(503).end();
      return true;
    };
    server.state.asked = [];
    await expect(downloadSet({ url: server.url, dir, trust })).rejects.toThrow(/answered 503/);
    expect(server.state.asked.find((a) => a.name === first.name)?.range).toBe(`bytes=${cut}-`);
    expect(await fileSha(path.join(dir, splitFile("esp")))).toBe(packed.files[splitFile("esp")].sha256);
    // Nothing reads as a set until every file of it is in.
    expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(false);
  }, 120_000);

  it("downloads from the release the build names, for its own version, over https or from this PC only", () => {
    const none = { readFileSync: () => "{}" } as unknown as typeof fs;
    expect(sourceOf({}, none)).toBeNull();
    expect(sourceOf({ SWIFF_OS_IMAGE_URL: "http://example.com/x/" }, none)).toBeNull();
    expect(sourceOf({ SWIFF_OS_IMAGE_URL: "http://127.0.0.1:8080/x" }, none)).toBe(
      "http://127.0.0.1:8080/x/",
    );
    expect(sourceOf({})).toBe(
      `https://github.com/tomnotthomas/distributed_gaming/releases/download/swiffos-${SWIFF_OS.version}/`,
    );
  });
});
