// NVIDIA's driver from Ubuntu onto the games drive (nvidia.cjs), against a
// fake Ubuntu server and a real temporary folder: what the owner accepted is
// recorded, every package is checked before it takes its name, and each way
// it fails says which.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTANCE_FILE,
  driverFolder,
  driverState,
  fetchLicence,
  installDriver,
  MANIFEST_FILE,
  parseManifest,
  readManifest,
  removeDriver,
  SPARE_BYTES,
  TERMS_VERSION,
  type NvidiaManifest,
} from "../nvidia.cjs";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const LICENCE = "NVIDIA Driver License Agreement\n...";
const PACKAGES = {
  "libnvidia-gl-595_1_amd64.deb": "gl ".repeat(5000),
  "nvidia-utils-595_1_amd64.deb": "utils",
};
const MANIFEST: NvidiaManifest = parseManifest(
  [
    "# a comment",
    "version 595.91.07",
    "mirror https://snapshot.example/ubuntu/20261001T000000Z/",
    "licence https://changelogs.example/copyright",
    `licence-sha256 ${sha(LICENCE)}`,
    ...Object.entries(PACKAGES).map(
      ([name, body]) =>
        `file ${sha(body)} ${body.length} pool/restricted/n/nvidia-graphics-drivers-595/${name}`,
    ),
  ].join("\n"),
);

/** A fake Ubuntu: each URL's body, sent in small chunks, or a status, or a dropped connection. */
function ubuntu(answers: Record<string, string | number | Error> = {}) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const answer =
      answers[url] ??
      (url === MANIFEST.licence.url
        ? LICENCE
        : Object.entries(PACKAGES).find(([name]) => url.endsWith(`/${name}`))?.[1]);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response(null, { status: answer });
    if (answer === undefined) return new Response(null, { status: 404 });
    const bytes = Buffer.from(answer);
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(at, (at += 4096)));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A games drive folder and the app's data folder, both empty. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "swiff-nvidia-"));
  dirs.push(root);
  return { folder: join(root, "games", "SwiffOS", "nvidia", MANIFEST.version), dataDir: join(root, "data") };
}
const NOW = () => new Date("2026-10-06T08:00:00.000Z");

describe("the manifest", () => {
  it("is the image's, byte for byte: the host app downloads what Swiff OS checks", () => {
    const image = join(
      __dirname,
      "../../swiff-os/image/mkosi.images/system/mkosi.extra/usr/lib/swiff/nvidia-driver",
    );
    expect(readFileSync(MANIFEST_FILE, "utf8")).toBe(readFileSync(image, "utf8"));
  });

  it("names one release, NVIDIA's licence and every package of it, from Ubuntu's archive", () => {
    const manifest = readManifest();
    expect(manifest.version).toMatch(/^595\.\d+\.\d+$/);
    expect(manifest.mirror).toMatch(/^https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z$/);
    expect(manifest.licence.url).toMatch(/^https:\/\/changelogs\.ubuntu\.com\/.*\/copyright$/);
    expect(manifest.files.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^nvidia-kernel-common-595_/),
        expect.stringMatching(/^nvidia-firmware-595-/),
        expect.stringMatching(/^libnvidia-gl-595_.*_amd64\.deb$/),
        expect.stringMatching(/^libnvidia-gl-595_.*_i386\.deb$/),
        expect.stringMatching(/^libnvidia-encode-595_/),
      ]),
    );
    // Only NVIDIA's own packages: the image has everything else they need.
    expect(manifest.files.every((f) => /^(lib)?nvidia-/.test(f.name))).toBe(true);
    expect(manifest.bytes).toBe(manifest.files.reduce((sum, f) => sum + f.size, 0));
  });

  it("refuses a manifest missing a field or with a malformed package", () => {
    expect(() => parseManifest(`version 1\nmirror m\nlicence l\nfile ${sha("a")} 1 pool/a.deb\n`)).toThrow(
      /licence-sha256/,
    );
    expect(() =>
      parseManifest(`version 1\nmirror m\nlicence l\nlicence-sha256 ${sha("x")}\nfile nothex 1 pool/a.deb\n`),
    ).toThrow(/malformed/);
    expect(() =>
      parseManifest(
        `version 1\nmirror m\nlicence l\nlicence-sha256 ${sha("x")}\nfile ${sha("a")} 1 ../a.deb\n`,
      ),
    ).toThrow(/malformed/);
    expect(() =>
      parseManifest(
        `version 1\nmirror m\nlicence l\nlicence-sha256 ${sha("x")}\nfile ${sha("a")} 1 pool/../a.deb\n`,
      ),
    ).toThrow(/malformed/);
  });

  it("puts the driver on the games drive where Swiff OS looks", () => {
    expect(driverFolder("D", "595.91.07")).toBe("D:\\SwiffOS\\nvidia\\595.91.07");
  });
});

describe("NVIDIA's licence", () => {
  it("is the text Ubuntu publishes for this release, checked against the manifest", async () => {
    expect(await fetchLicence({ manifest: MANIFEST, fetch: ubuntu().fetch })).toEqual({
      ok: true,
      text: LICENCE,
    });
  });

  it("is not shown when Ubuntu sends another text, or cannot be reached", async () => {
    const changed = ubuntu({ [MANIFEST.licence.url]: `${LICENCE} (changed)` });
    expect(await fetchLicence({ manifest: MANIFEST, fetch: changed.fetch })).toEqual({
      ok: false,
      error: "changed",
    });
    const offline = ubuntu({ [MANIFEST.licence.url]: new TypeError("fetch failed") });
    expect(await fetchLicence({ manifest: MANIFEST, fetch: offline.fetch })).toEqual({
      ok: false,
      error: "offline",
    });
    const busy = ubuntu({ [MANIFEST.licence.url]: 503 });
    expect(await fetchLicence({ manifest: MANIFEST, fetch: busy.fetch })).toEqual({
      ok: false,
      error: "server",
    });
  });
});

describe("installing the driver", () => {
  it("records what the owner accepted, then downloads every package from Ubuntu, checked", async () => {
    const { folder, dataDir } = place();
    const { fetch, asked } = ubuntu();
    const progress: number[] = [];
    const done = await installDriver({
      manifest: MANIFEST,
      folder,
      dataDir,
      free: 10 * 1024 ** 3,
      fetch,
      now: NOW,
      onProgress: (n, total) => {
        expect(total).toBe(MANIFEST.bytes);
        progress.push(n);
      },
    });
    expect(done).toEqual({ ok: true });
    expect(asked).toEqual(
      Object.keys(PACKAGES).map(
        (name) =>
          `https://snapshot.example/ubuntu/20261001T000000Z/pool/restricted/n/nvidia-graphics-drivers-595/${name}`,
      ),
    );
    expect(readdirSync(folder).sort()).toEqual(Object.keys(PACKAGES).sort());
    for (const [name, body] of Object.entries(PACKAGES))
      expect(readFileSync(join(folder, name), "utf8")).toBe(body);
    expect(progress.at(-1)).toBe(MANIFEST.bytes);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(JSON.parse(readFileSync(join(dataDir, ACCEPTANCE_FILE), "utf8"))).toEqual({
      driver: "595.91.07",
      licence: MANIFEST.licence.url,
      licenceSha256: MANIFEST.licence.sha256,
      terms: TERMS_VERSION,
      acceptedAt: "2026-10-06T08:00:00.000Z",
    });
    expect(driverState({ manifest: MANIFEST, letter: null, dataDir }).accepted).toEqual({
      at: "2026-10-06T08:00:00.000Z",
    });
  });

  it("keeps packages already there and whole, so a stopped install picks up where it was", async () => {
    const { folder, dataDir } = place();
    await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: ubuntu().fetch });
    const again = ubuntu();
    expect(await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: again.fetch })).toEqual({
      ok: true,
    });
    expect(again.asked).toEqual([]);
    // A package changed on the drive is downloaded again.
    const [name] = Object.keys(PACKAGES);
    writeFileSync(join(folder, name!), "tampered");
    const third = ubuntu();
    expect(await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: third.fetch })).toEqual({
      ok: true,
    });
    expect(third.asked).toHaveLength(1);
    expect(readFileSync(join(folder, name!), "utf8")).toBe(PACKAGES[name as keyof typeof PACKAGES]);
  });

  it("keeps nothing Ubuntu sends that is not the package Swiff OS expects", async () => {
    const { folder, dataDir } = place();
    const [name, body] = Object.entries(PACKAGES)[0]!;
    const url = `${MANIFEST.mirror}/pool/restricted/n/nvidia-graphics-drivers-595/${name}`;
    const same = await installDriver({
      manifest: MANIFEST,
      folder,
      dataDir,
      fetch: ubuntu({ [url]: `${body.slice(1)}x` }).fetch,
    });
    expect(same).toEqual({ ok: false, error: "changed" });
    const longer = await installDriver({
      manifest: MANIFEST,
      folder,
      dataDir,
      fetch: ubuntu({ [url]: `${body}x` }).fetch,
    });
    expect(longer).toEqual({ ok: false, error: "changed" });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("says why it failed: offline, gone from Ubuntu, a server error, no room, or stopped", async () => {
    const { folder, dataDir } = place();
    const url = `${MANIFEST.mirror}/${MANIFEST.files[0]!.path}`;
    const run = (fetch: typeof globalThis.fetch, extra = {}) =>
      installDriver({ manifest: MANIFEST, folder, dataDir, fetch, ...extra });
    expect(await run(ubuntu({ [url]: new TypeError("fetch failed") }).fetch)).toEqual({
      ok: false,
      error: "offline",
    });
    expect(await run(ubuntu({ [url]: 404 }).fetch)).toEqual({ ok: false, error: "gone" });
    expect(await run(ubuntu({ [url]: 502 }).fetch)).toEqual({ ok: false, error: "server" });
    expect(await run(ubuntu().fetch, { free: MANIFEST.bytes + SPARE_BYTES - 1 })).toEqual({
      ok: false,
      error: "space",
    });
    const stop = new AbortController();
    stop.abort();
    expect(await run(ubuntu().fetch, { signal: stop.signal })).toEqual({ ok: false, error: "cancelled" });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("says when the games drive cannot be written", async () => {
    const { dataDir } = place();
    const file = join(dataDir, "..", "a-file");
    writeFileSync(file, "");
    const res = await installDriver({
      manifest: MANIFEST,
      folder: join(file, "under"),
      dataDir,
      fetch: ubuntu().fetch,
    });
    expect(res).toEqual({ ok: false, error: "write" });
  });
});

describe("the driver on this PC", () => {
  it("is installed when every package is on the games drive at its size", async () => {
    const { folder, dataDir } = place();
    const state = (dir: string | null) =>
      driverState({
        manifest: MANIFEST,
        letter: dir ? "D" : null,
        dataDir,
        files: {
          statSync: (p: string) => ({
            size: readFileSync(p.replace(driverFolder("D", MANIFEST.version), folder)).length,
          }),
          readFileSync,
        },
      });
    expect(state(null)).toEqual({
      version: "595.91.07",
      bytes: MANIFEST.bytes,
      folder: null,
      installed: false,
      accepted: null,
    });
    expect(state(folder).installed).toBe(false);
    await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: ubuntu().fetch, now: NOW });
    expect(state(folder)).toMatchObject({ folder: driverFolder("D", "595.91.07"), installed: true });
  });

  it("asks again when the licence or Swiff's terms changed since the owner accepted", async () => {
    const { folder, dataDir } = place();
    await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: ubuntu().fetch, now: NOW });
    const accepted = (manifest: NvidiaManifest) => driverState({ manifest, letter: null, dataDir }).accepted;
    expect(accepted(MANIFEST)).not.toBeNull();
    expect(accepted({ ...MANIFEST, licence: { ...MANIFEST.licence, sha256: sha("another") } })).toBeNull();
    expect(accepted({ ...MANIFEST, version: "595.99.01" })).toBeNull();
    const record = JSON.parse(readFileSync(join(dataDir, ACCEPTANCE_FILE), "utf8"));
    writeFileSync(join(dataDir, ACCEPTANCE_FILE), JSON.stringify({ ...record, terms: "an older version" }));
    expect(accepted(MANIFEST)).toBeNull();
  });

  it("is removed, with the acceptance, when the owner asks", async () => {
    const { folder, dataDir } = place();
    await installDriver({ manifest: MANIFEST, folder, dataDir, fetch: ubuntu().fetch });
    expect(removeDriver({ folder, dataDir })).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(dataDir, ACCEPTANCE_FILE))).toBe(false);
  });
});
