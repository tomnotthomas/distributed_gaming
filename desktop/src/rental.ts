// What the rental-mode screen says about this PC: each thing Swiff OS needs,
// whether it is ready, and what the owner has to change in the BIOS, which
// Swiff cannot do for them.
//
// The hardware floor is captain decision D3, still open. Until it is decided,
// it is the report's recommendation, mirrored from Swiff OS's own check
// (swiff-os/image/.../usr/lib/swiff/rental-policy.conf): UEFI, Secure Boot,
// TPM 2.0 with an endorsement key certificate and an IOMMU, with a TPM on
// its own chip accepted at a lower trust tier. Change it here and there.

import type { RentalRead, RentalTarget } from "../rental.cjs";
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

export type RentalCheck = { id: string; label: string; value: string; state: CheckState; bios?: string };

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
  "On the first start of Swiff OS, confirm its key once at the screen (MOK), with the PC's keyboard.",
];

/** The Windows-side checks: space, the games drive, the graphics card, Fast Startup. */
export function pcChecks(read: RentalRead, targetId: string | null): RentalCheck[] {
  const { facts, games, need } = read;
  const target = chosenTarget(read, targetId);
  const nvidia = facts.gpus.find((g) => g.vendor === "nvidia");
  const gpu = nvidia ?? facts.gpus.find((g) => g.vendor !== "other") ?? facts.gpus[0];
  return [
    {
      id: "space",
      label: "Space",
      ...(target
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
    {
      id: "gpu",
      label: "Graphics",
      ...(!gpu
        ? { value: "Not read", state: "unread" }
        : gpu.vendor === "nvidia"
          ? { value: `${shortGpu(gpu.name)}: not yet`, state: "blocked" }
          : { value: shortGpu(gpu.name), state: "ok" }),
    },
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
    if (check.id === "gpu") fixes.push("NVIDIA graphics cards come in a later Swiff OS update.");
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
    line: `Swiff OS takes a fixed ${gb(read.need)} next to Windows. Installing it turns off Fast Startup.`,
    ready,
    of: checks.length,
    bios,
    fixes,
    canInstall,
  };
}
