import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { linuxSystem, runWithin, windowsFirst, type Run } from "./system.ts";

const ALL = { uefi: true, secureBoot: true, tpm2: true, iommu: true };

/** A root directory holding `files`, as sysfs would show them. */
async function machine(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swiff-hostd-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const SECURE_BOOT = "sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";

const LISTING = `BootCurrent: 0003
Timeout: 1 seconds
BootOrder: 0003,0000,0001
Boot0000* Windows Boot Manager\tHD(1,GPT,0000)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)
Boot0001* UEFI: PXE IPv4\tPciRoot(0x0)
Boot0003* Swiff OS\tHD(1,GPT,0000)/File(\\EFI\\swiff\\shimx64.efi)
`;

describe("the hardware floor (D3)", () => {
  it("is met by a UEFI machine with Secure Boot on, a TPM 2.0 and an IOMMU", async () => {
    const root = await machine({
      [SECURE_BOOT]: Buffer.from([6, 0, 0, 0, 1]),
      "sys/class/tpm/tpm0/tpm_version_major": "2\n",
      "sys/class/iommu/dmar0/uevent": "",
    });
    expect(await linuxSystem(ALL, root).unmetFloor()).toEqual([]);
  });

  it("names each check a machine fails", async () => {
    const root = await machine({
      [SECURE_BOOT]: Buffer.from([6, 0, 0, 0, 0]),
      "sys/class/tpm/tpm0/tpm_version_major": "1\n",
    });
    expect(await linuxSystem(ALL, root).unmetFloor()).toEqual(["secureBoot", "tpm2", "iommu"]);
    expect(await linuxSystem(ALL, await machine({})).unmetFloor()).toEqual([
      "uefi",
      "secureBoot",
      "tpm2",
      "iommu",
    ]);
  });

  it("skips a check the floor leaves out", async () => {
    const floor = { uefi: true, secureBoot: false, tpm2: false, iommu: false };
    expect(await linuxSystem(floor, await machine({})).unmetFloor()).toEqual(["uefi"]);
  });
});

describe("the boot id", () => {
  it("is the kernel's, read without its newline", async () => {
    const root = await machine({
      "proc/sys/kernel/random/boot_id": "6f1c2a9e-0b7d-4e4b-9d1a-2f3c4b5a6d7e\n",
    });
    expect(await linuxSystem(ALL, root).bootId()).toBe("6f1c2a9e-0b7d-4e4b-9d1a-2f3c4b5a6d7e");
  });
});

describe("going back to Windows", () => {
  it("puts Windows Boot Manager first and keeps the rest in order", () => {
    expect(windowsFirst(LISTING)).toBe("0000,0003,0001");
  });

  it("adds Windows when the boot order lacks it, and finds none when there is none", () => {
    expect(windowsFirst("BootOrder: 0003\nBoot0000* Windows Boot Manager\tHD()\n")).toBe("0000,0003");
    expect(windowsFirst("BootOrder: 0003\nBoot0003* Swiff OS\tHD()\n")).toBeNull();
  });

  it("sets the order and reboots, and reboots nowhere without a Windows entry", async () => {
    const ran: string[] = [];
    const exec =
      (listing: string): Run =>
      async (command, args) => {
        ran.push([command, ...args].join(" "));
        return command === "efibootmgr" && args.length === 0 ? listing : "";
      };
    await linuxSystem(ALL, "/", exec(LISTING)).returnToWindows();
    expect(ran).toEqual(["efibootmgr", "efibootmgr --bootorder 0000,0003,0001", "systemctl reboot"]);

    ran.length = 0;
    await expect(linuxSystem(ALL, "/", exec("BootOrder: 0003\n")).returnToWindows()).rejects.toThrow(
      /Windows/,
    );
    expect(ran).toEqual(["efibootmgr"]);
  });
});

describe("a command with a time limit", () => {
  it("gives its output when it finishes in time, and fails once it runs too long", async () => {
    expect(await runWithin(5_000)("echo", ["done"])).toBe("done\n");
    await expect(runWithin(50)("sleep", ["5"])).rejects.toThrow();
  });
});

describe("the Steam client kept for the next boot (steam/client)", () => {
  it("is ready once keeping it is done, and is closed under the lock a keeping holds", async () => {
    const root = await machine({});
    const runs: string[][] = [];
    const system = linuxSystem(ALL, root, async (command, args) => {
      runs.push([command, ...args]);
      return "";
    });
    expect(await system.steamClientReady()).toBe(false);
    await mkdir(join(root, "run/swiff/steam-client"), { recursive: true });
    await writeFile(join(root, "run/swiff/steam-client/done"), "saved\n");
    expect(await system.steamClientReady()).toBe(true);
    await system.closeSteamClient();
    const dir = join(root, "run/swiff/steam-client");
    expect(runs).toEqual([["flock", join(dir, "lock"), "touch", join(dir, "closed")]]);
  });
});
