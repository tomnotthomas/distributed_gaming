// @vitest-environment node
// The SHA-256 sums the release step publishes for hosts (checksums.cjs): as
// sha256sum prints and checks them, and as the download page shows them.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageSums, parseSums, releaseOf, sumOf, sumsText } from "../checksums.cjs";
import RELEASE from "../../web/src/swiff/release.json";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swiff-sums-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("checksums", () => {
  it("hashes a file in chunks to the SHA-256 of all of it, with its size", () => {
    const data = Buffer.alloc(9 * 1024 * 1024 + 7, 0x5a);
    fs.writeFileSync(path.join(dir, "SwiffHost-0.1.0.exe"), data);
    expect(sumOf(path.join(dir, "SwiffHost-0.1.0.exe"))).toEqual({
      name: "SwiffHost-0.1.0.exe",
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    });
  });

  it("writes and reads SHA256SUMS as sha256sum does, and refuses a line that is not one", () => {
    const sums = [
      { name: "swiffos.json", sha256: "a".repeat(64) },
      { name: "swiffos_0.1.0.esp.raw", sha256: "b".repeat(64) },
    ];
    expect(sumsText(sums)).toBe(
      `${"a".repeat(64)}  swiffos.json\n${"b".repeat(64)}  swiffos_0.1.0.esp.raw\n`,
    );
    expect(parseSums(sumsText(sums))).toEqual(sums);
    expect(parseSums(`${"c".repeat(64)} *binary.raw\r\n`)).toEqual([
      { name: "binary.raw", sha256: "c".repeat(64) },
    ]);
    expect(() => parseSums("deadbeef  short\n")).toThrow(/Not a SHA256SUMS line/);
  });

  it("makes what the download page shows: the installer, its address once published, and the image set", () => {
    fs.writeFileSync(path.join(dir, "swiffos.json"), JSON.stringify({ version: "0.1.0" }));
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${"d".repeat(64)}  swiffos.json\n`);
    const host = { name: "SwiffHost-0.1.0.exe", sha256: "e".repeat(64), bytes: 10 };
    expect(releaseOf({ host, image: imageSums(dir) })).toEqual({
      host: { file: "SwiffHost-0.1.0.exe", sha256: "e".repeat(64), bytes: 10, url: null },
      image: { version: "0.1.0", files: [{ name: "swiffos.json", sha256: "d".repeat(64) }] },
    });
    expect(releaseOf({ host, url: "https://example.test/SwiffHost.exe" }).host!.url).toBe(
      "https://example.test/SwiffHost.exe",
    );
    expect(() => releaseOf({ host, url: "http://example.test/x.exe" })).toThrow(/https/);
    expect(releaseOf()).toEqual({ host: null, image: null });
  });

  it("ships the website a release file in the shape it reads", () => {
    expect(Object.keys(RELEASE).sort()).toEqual(["host", "image"]);
  });
});
