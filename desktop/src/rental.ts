// What the rental-mode screen says about this PC: each thing Swiff OS needs,
// whether it is ready, and what the owner has to change in the BIOS, which
// Swiff cannot do for them.
//
// The hardware floor is captain decision D3, still open. Until it is decided,
// it is the report's recommendation, mirrored from Swiff OS's own check
// (swiff-os/image/.../usr/lib/swiff/rental-policy.conf): UEFI, Secure Boot,
// TPM 2.0 with an endorsement key certificate and an IOMMU, with a TPM on
// its own chip accepted at a lower trust tier. Change it here and there.

import type { RentalFacts, RentalRead, RentalTarget } from "../rental.cjs";
import { shortGpu } from "./format";

/**
 *   ok       ready
 *   swiff    not ready, and the install changes it
 *   unchecked  needs administrator rights to read: not checked yet, and not ready
 *   bios     the owner changes it in the BIOS setup
 *   blocked  rental mode cannot run until the owner changes it in Windows
 *   unread   could not be read; not held against the PC
 */
export type CheckState = "ok" | "swiff" | "unchecked" | "bios" | "blocked" | "unread";

/** `detail` is a line under the row that says more about it: what was found, and what it means. */
export type RentalCheck = {
  id: string;
  label: string;
  value: string;
  state: CheckState;
  bios?: string;
  detail?: string;
};

/** Ready, or ready once installing has done its part. */
export const isReady = (state: CheckState): boolean =>
  state === "ok" || state === "swiff" || state === "unread";

/** 25,367,150,592 bytes → "24 GB". */
export const gb = (bytes: number): string => `${Math.round(bytes / 1024 ** 3)} GB`;

/** The target chosen by id, else the best one when none was chosen; null when the chosen one is gone. */
export const chosenTarget = (read: RentalRead, id: string | null): RentalTarget | null =>
  id === null ? (read.targets[0] ?? null) : (read.targets.find((t) => t.id === id) ?? null);

/** The owner chose a place for Swiff OS that this read no longer offers. */
export const choiceGone = (read: RentalRead, id: string | null): boolean =>
  id !== null && read.targets.length > 0 && !chosenTarget(read, id);

/** Where Swiff OS goes, in words: "24 GB from C:", "24 GB of free space on disk 1". */
export function targetLine(target: RentalTarget, need: number): string {
  return target.kind === "shrink"
    ? `${gb(need)} from ${target.letter}:`
    : `${gb(need)} of free space on disk ${target.disk}`;
}

/** The firmware checks: what the BIOS decides. */
export function firmwareChecks({ facts }: RentalRead): RentalCheck[] {
  const { tpm } = facts;
  const tpmValue = !tpm.present
    ? "Not found"
    : tpm.firmware === null
      ? "2.0"
      : tpm.firmware
        ? `2.0, in the processor${tpm.maker === "AMD" ? " (AMD fTPM)" : tpm.maker === "INTC" ? " (Intel PTT)" : ""}`
        : "2.0, separate chip: lower tier";
  return [
    {
      id: "uefi",
      label: "UEFI start",
      ...(facts.uefi === null
        ? { value: "Not read", state: "unread" }
        : facts.uefi
          ? { value: "Yes", state: "ok" }
          : {
              value: "Legacy BIOS",
              state: "bios",
              bios: "Turn off CSM (Legacy boot), so the PC starts in UEFI mode.",
            }),
    },
    {
      id: "secure-boot",
      label: "Secure Boot",
      ...(facts.secureBoot === null
        ? { value: "Not read", state: "unread" }
        : facts.secureBoot
          ? { value: "On", state: "ok" }
          : { value: "Off", state: "bios", bios: "Turn on Secure Boot." }),
    },
    {
      id: "tpm",
      label: "TPM",
      ...(tpm.present === null
        ? { value: "Not read", state: "unread" }
        : tpm.present
          ? { value: tpmValue, state: "ok" }
          : { value: tpmValue, state: "bios", bios: "Turn on the TPM: AMD fTPM or Intel PTT." }),
    },
    {
      id: "iommu",
      label: "IOMMU",
      ...(facts.iommu === null
        ? { value: "Not read", state: "unread" }
        : facts.iommu
          ? { value: "On", state: "ok" }
          : {
              value: "Off",
              state: "bios",
              bios: "Turn on the IOMMU (AMD-Vi or Intel VT-d) and Kernel DMA Protection.",
            }),
    },
    // The Secure Boot db and the TPM's endorsement certificate need administrator rights to read.
    { id: "db", label: "Microsoft UEFI CA 2023", value: "Not checked yet", state: "unchecked" },
    { id: "ek", label: "TPM certificate", value: "Not checked yet", state: "unchecked" },
  ] as RentalCheck[];
}

/**
 * The BIOS steps Swiff cannot see from Windows without administrator rights,
 * so the owner is told about each one up front.
 */
export const BIOS_STEPS: readonly string[] = [
  "If Secure Boot is in Setup Mode, leave it: restore the factory keys, then turn Secure Boot on.",
  "On a Secured-core PC, turn on Allow Microsoft 3rd-party UEFI CA in the Secure Boot settings.",
  "If the firmware lacks the Microsoft UEFI CA 2023, update the BIOS, or let Windows Update add it to the Secure Boot db.",
];

/**
 * What the owner sees after the install's restart, and does: shim's MokManager,
 * screen by screen, in its own words. It waits 10 seconds for a key, takes
 * three tries at the code and shows nothing as it is typed.
 */
export const MOK_SCREENS: readonly { screen: string; act: string }[] = [
  { screen: "Press any key to perform MOK management", act: "Press any key within 10 seconds." },
  { screen: "Perform MOK management", act: "Choose Enroll MOK." },
  { screen: "[Enroll MOK]", act: "Choose Continue." },
  { screen: "Enroll the key(s)?", act: "Choose Yes." },
  { screen: "Password:", act: "Type the code, then press Enter. The screen shows nothing as you type." },
  { screen: "Perform MOK management", act: "Choose Reboot. The PC starts Windows again." },
];

/** "48217730" → "4821 7730": read in two halves, typed without the space. */
export const codeGroups = (code: string): string => code.replace(/(\d{4})(?=\d)/g, "$1 ");

/**
 * The NVIDIA driver series Swiff OS ships: Canonical's signed open kernel
 * modules (swiff-os/image/mkosi.images/system/mkosi.conf). Change it here and
 * there. It runs Turing and newer, the GeForce GTX 16 and RTX 20 series on:
 * PCI device numbers from 0x1E00, the first Turing chip. NVIDIA moved every
 * older card to its legacy driver branches.
 */
export const SWIFF_OS_NVIDIA = "595";
const NVIDIA_FIRST_SUPPORTED = 0x1e00;

type Gpu = RentalFacts["gpus"][number];

/** Whether Swiff OS's NVIDIA driver runs this card; null when its model was not read. */
export const nvidiaSupported = (gpu: Gpu): boolean | null =>
  gpu.device === null ? null : gpu.device >= NVIDIA_FIRST_SUPPORTED;

/** Windows' number for an NVIDIA driver as NVIDIA says it: "32.0.15.6094" → "560.94". */
export function nvidiaVersion(windows: string): string | null {
  const digits = windows.split(".").slice(-2).join("");
  if (!/^\d{5,}$/.test(digits)) return null;
  const last = digits.slice(-5);
  return `${Number(last.slice(0, 3))}.${last.slice(3)}`;
}

/** The card rental mode would run on: an NVIDIA card Swiff OS runs, else any NVIDIA, else AMD or Intel. */
function rentalGpu(gpus: Gpu[]): Gpu | undefined {
  const nvidia = gpus.filter((g) => g.vendor === "nvidia");
  return (
    nvidia.find((g) => nvidiaSupported(g)) ?? nvidia[0] ?? gpus.find((g) => g.vendor !== "other") ?? gpus[0]
  );
}

/**
 * The graphics card, the driver Swiff OS runs it on, and whether it can. An
 * NVIDIA card Swiff OS runs still waits while NVIDIA is in testing (the app's
 * --nvidia-rental flag lifts that, for the hardware test).
 */
function gpuCheck(gpu: Gpu | undefined, nvidiaRental: boolean): RentalCheck {
  const check = { id: "gpu", label: "Graphics" };
  if (!gpu) return { ...check, value: "Not read", state: "unread" };
  const name = shortGpu(gpu.name);
  // Windows' own driver, beside Swiff OS's: what the owner can check against NVIDIA's or AMD's numbers.
  const windows = gpu.driver
    ? `, Windows on ${(gpu.vendor === "nvidia" && nvidiaVersion(gpu.driver)) || gpu.driver}`
    : "";
  if (gpu.vendor !== "nvidia")
    return {
      ...check,
      value: name,
      state: "ok",
      detail: `Swiff OS runs it on the open Mesa driver${windows}.`,
    };
  const series = "GeForce GTX 16 and RTX 20 series cards and newer";
  switch (nvidiaSupported(gpu)) {
    case true:
      if (!nvidiaRental)
        return {
          ...check,
          value: `${name}: in testing`,
          state: "blocked",
          detail: `NVIDIA support is in testing: Swiff OS will run it on NVIDIA's ${SWIFF_OS_NVIDIA} driver${windows}.`,
        };
      return {
        ...check,
        value: name,
        state: "ok",
        detail: `Supported: Swiff OS runs it on NVIDIA's ${SWIFF_OS_NVIDIA} driver${windows}.`,
      };
    case false:
      return {
        ...check,
        value: `${name}: too old`,
        state: "blocked",
        detail: `Swiff OS's NVIDIA ${SWIFF_OS_NVIDIA} driver runs ${series}.`,
      };
    default:
      return {
        ...check,
        value: `${name}: model not read`,
        state: "unread",
        detail: `Swiff OS's NVIDIA ${SWIFF_OS_NVIDIA} driver runs ${series}.`,
      };
  }
}

/** The Windows-side checks: space, the games drive, the graphics card, Fast Startup. */
export function pcChecks(read: RentalRead, targetId: string | null): RentalCheck[] {
  const { facts, games, need } = read;
  const target = chosenTarget(read, targetId);
  return [
    {
      id: "space",
      label: "Space",
      ...(read.installed
        ? { value: `${gb(need)}: Swiff OS is installed`, state: "ok" }
        : target
          ? { value: targetLine(target, need), state: "ok" }
          : choiceGone(read, targetId)
            ? { value: "The drive you chose is no longer available: choose again", state: "blocked" }
            : { value: `No drive has ${gb(need)} free`, state: "blocked" }),
    },
    {
      id: "games",
      label: "Games drive",
      ...(!games
        ? { value: "No Steam library yet", state: "unread" }
        : games.bitlocker === "on"
          ? { value: `${games.letter}:, BitLocker on`, state: "blocked" }
          : games.bitlocker === "off"
            ? { value: `${games.letter}:, BitLocker off`, state: "ok" }
            : { value: `${games.letter}:, BitLocker not read`, state: "unread" }),
    },
    gpuCheck(rentalGpu(facts.gpus), read.nvidiaRental),
    {
      id: "fast-startup",
      label: "Fast Startup",
      ...(facts.fastStartup === null
        ? { value: "Not read", state: "unread" }
        : facts.fastStartup
          ? { value: "On: Swiff turns it off", state: "swiff" }
          : { value: "Off", state: "ok" }),
    },
  ] as RentalCheck[];
}

/** What blocks rental mode in Windows, as one sentence each. */
export function windowsFixes(read: RentalRead, targetId: string | null): string[] {
  const fixes: string[] = [];
  for (const check of pcChecks(read, targetId)) {
    if (check.state !== "blocked") continue;
    if (check.id === "space")
      fixes.push(
        choiceGone(read, targetId)
          ? "The drive you chose for Swiff OS is no longer available: choose again where it goes."
          : `Free up ${gb(read.need)} on a drive, or add a second drive: Swiff OS needs its own space.`,
      );
    if (check.id === "games")
      fixes.push(
        `Turn off BitLocker on ${read.games?.letter}:, or move your Steam library to a drive without it: Swiff OS cannot read an encrypted drive.`,
      );
    if (check.id === "gpu") {
      const gpu = rentalGpu(read.facts.gpus)!;
      fixes.push(
        nvidiaSupported(gpu)
          ? `NVIDIA support is in testing: rental mode takes the ${shortGpu(gpu.name)} once it passes. Sharing from Windows works as before.`
          : `Fit a GeForce GTX 16 or RTX 20 series card or newer to use rental mode: Swiff OS's NVIDIA driver does not run the ${shortGpu(gpu.name)}. Sharing from Windows works as before.`,
      );
    }
  }
  return fixes;
}

export type RentalStatus = {
  title: string;
  line: string;
  ready: number;
  of: number;
  bios: string[];
  fixes: string[];
  canInstall: boolean;
};

/** The statement at the top of the screen, and the counts its dial shows. */
export function rentalStatus(read: RentalRead, targetId: string | null): RentalStatus {
  const checks = [...firmwareChecks(read), ...pcChecks(read, targetId)];
  const ready = checks.filter((c) => isReady(c.state)).length;
  const bios = checks.flatMap((c) => (c.state === "bios" && c.bios ? [c.bios] : []));
  const fixes = windowsFixes(read, targetId);
  const canInstall = !bios.length && !fixes.length && !read.installed;
  const many = (n: number, one: string, more: string) => (n === 1 ? one : more.replace("#", String(n)));
  if (read.installed)
    return {
      title: "Rental mode is installed",
      line: "Switching into Swiff OS when you go live is a preview for now: Go live still shares from Windows.",
      ready,
      of: checks.length,
      bios,
      fixes,
      canInstall,
    };
  if (bios.length)
    return {
      title: many(bios.length, "One change in the BIOS", "# changes in the BIOS"),
      line: "Swiff cannot change these. Restart into the BIOS setup (F2 or Del at start), make them, then check again.",
      ready,
      of: checks.length,
      bios,
      fixes,
      canInstall,
    };
  if (fixes.length)
    return {
      title: many(fixes.length, "One thing to change first", "# things to change first"),
      line: "Rental mode cannot run on this PC until then.",
      ready,
      of: checks.length,
      bios,
      fixes,
      canInstall,
    };
  return {
    title: "Ready for rental mode",
    line: `Swiff OS takes a fixed ${gb(read.need)} next to Windows. Installing it turns off Fast Startup and restarts the PC once, to confirm Swiff's key.`,
    ready,
    of: checks.length,
    bios,
    fixes,
    canInstall,
  };
}
