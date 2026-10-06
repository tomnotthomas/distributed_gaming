// What the rental-mode screen says about this PC: each thing Swiff OS needs,
// whether it is ready, and, one at a time, what the owner has to do next:
// a change in Windows, a trip to the BIOS (which Swiff cannot make for them),
// the install, or Swiff's key at the blue screen after its restart.
//
// The hardware floor is captain decision D3, still open. Until it is decided,
// it is the report's recommendation, mirrored from Swiff OS's own check
// (swiff-os/image/.../usr/lib/swiff/rental-policy.conf): UEFI, Secure Boot,
// TPM 2.0 with an endorsement key certificate and an IOMMU, with a TPM on
// its own chip accepted at a lower trust tier. Change it here and there.

import type { LastLive, PlanStep, RentalPlan, RentalRead, RentalTarget } from "../rental.cjs";
import type { RentalRun, RentalSetup, WritePass } from "./model";
import { clock, shortGpu } from "./format";

/**
 *   ok       ready
 *   swiff    not ready, and the install changes it
 *   bios     the owner changes it in the BIOS setup: only when a read shows it missing
 *   blocked  rental mode cannot run until the owner changes it in Windows
 *   unread   could not be read, or is read by the install's administrator step; not held against the PC
 */
export type CheckState = "ok" | "swiff" | "bios" | "blocked" | "unread";

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
    // From this start's measured-boot log: the db the firmware measured.
    {
      id: "ca",
      label: "Microsoft UEFI CA 2011",
      ...(facts.db === null
        ? { value: "Read when you install", state: "unread" }
        : facts.db
          ? { value: "Trusted", state: "ok" }
          : {
              value: "Not trusted",
              state: "bios",
              bios: "Allow the Microsoft 3rd-party UEFI CA.",
            }),
    },
    // Needs administrator rights: the install's first step reads it, and its record keeps it.
    {
      id: "ek",
      label: "TPM certificate",
      ...(facts.checked
        ? facts.checked.ek
          ? { value: "Present", state: "ok" }
          : { value: "None: lower tier", state: "ok" }
        : { value: "Read when you install", state: "unread" }),
    },
  ] as RentalCheck[];
}

/** "48217730" → "4821 7730": read in two halves, typed without the space. */
export const codeGroups = (code: string): string => code.replace(/(\d{4})(?=\d)/g, "$1 ");

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
          ? { value: `${games.letter}: BitLocker on`, state: "blocked" }
          : games.bitlocker === "off"
            ? { value: `${games.letter}: BitLocker off`, state: "ok" }
            : { value: `${games.letter}: BitLocker not read`, state: "unread" }),
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
      id: "image",
      label: "Swiff OS",
      ...(read.installed || read.image === undefined
        ? { value: read.installed ? "Installed" : "Not read", state: read.installed ? "ok" : "unread" }
        : read.image
          ? { value: `${read.image}, ready to install`, state: "ok" }
          : read.imageRefused
            ? { value: "Not signed by Swiff", state: "blocked" }
            : { value: "Its files are not on this PC", state: "blocked" }),
    },
    {
      id: "fast-startup",
      label: "Fast Startup",
      ...(facts.fastStartup === null
        ? { value: "Not read", state: "unread" }
        : facts.fastStartup
          ? { value: "On. The install turns it off", state: "swiff" }
          : { value: "Off", state: "ok" }),
    },
  ] as RentalCheck[];
}

// --- one thing at a time ----------------------------------------------------------------
//
// The screen never lists what is wrong: it names the one thing to do next, in
// this order. Windows first (the owner is there already), then every BIOS
// setting in one trip, then whatever only an update brings. Passing checks
// stay silent, and a check that needs administrator rights (or could not be
// read) is never held against the PC.

/** The BIOS settings Swiff OS needs, as the owner finds them in the setup screen. */
export type BiosId = "uefi" | "secure-boot" | "ca" | "tpm" | "iommu";

export type BiosAsk = { setting: string; value: string; title: string; hint: string };

export const BIOS_ASKS: Record<BiosId, BiosAsk> = {
  uefi: {
    setting: "CSM",
    value: "Disabled",
    title: "Turn off CSM",
    hint: "Also called Legacy boot or Compatibility mode.",
  },
  "secure-boot": {
    setting: "Secure Boot",
    value: "Enabled",
    title: "Turn on Secure Boot",
    hint: "Usually under Boot or Security.",
  },
  ca: {
    setting: "3rd-party CA",
    value: "Allowed",
    title: "Allow the 3rd-party UEFI CA",
    hint: "In the Secure Boot settings. No such switch? Restore the factory Secure Boot keys.",
  },
  tpm: {
    setting: "fTPM / PTT",
    value: "Enabled",
    title: "Turn on the TPM",
    hint: "Called AMD fTPM or Intel PTT, under Security or Advanced.",
  },
  iommu: {
    setting: "IOMMU",
    value: "Enabled",
    title: "Turn on IOMMU",
    hint: "Called AMD-Vi or Intel VT-d. Turn on Kernel DMA Protection too, if you see it.",
  },
};

// --- where the settings are, on this PC's firmware ----------------------------------------
//
// The BIOS setup screens differ by maker. Where the read names one this table
// knows (the PC's maker, else the firmware's), the strip names its key and its
// menu path; otherwise it keeps the general hints above.

type Paths = Partial<Record<BiosId, string | { amd: string; intel: string }>>;
export type FirmwareGuide = { name: string; keys: string[]; paths: Paths };

const AMI: FirmwareGuide = {
  name: "AMI Aptio",
  keys: ["Del", "F2"],
  paths: {
    uefi: "Advanced → CSM Configuration → CSM Support: Disabled",
    "secure-boot": "Security → Secure Boot → Secure Boot: Enabled",
    ca: "Security → Secure Boot → Key Management → Restore Factory Keys",
    tpm: "Advanced → Trusted Computing → Security Device Support: Enable",
    iommu: {
      amd: "Advanced → AMD CBS → NBIO Common Options → IOMMU: Enabled",
      intel: "Chipset → System Agent (SA) Configuration → VT-d: Enabled",
    },
  },
};

/** By the PC's maker (Win32_ComputerSystem), then by the firmware's (Win32_BIOS). */
const GUIDES: { maker?: RegExp; bios?: RegExp; guide: FirmwareGuide }[] = [
  {
    maker: /lenovo/i,
    guide: {
      name: "Lenovo",
      keys: ["F1", "F2"],
      paths: {
        uefi: "Startup → UEFI/Legacy Boot: UEFI Only",
        "secure-boot": "Security → Secure Boot → Secure Boot: On",
        ca: "Security → Secure Boot → Allow Microsoft 3rd Party UEFI CA: On",
        tpm: "Security → Security Chip → Security Chip: Enabled",
        iommu: "Security → Virtualization → Kernel DMA Protection: On",
      },
    },
  },
  {
    maker: /dell/i,
    guide: {
      name: "Dell",
      keys: ["F2"],
      paths: {
        uefi: "Boot Configuration → Enable Legacy Option ROMs: Off",
        "secure-boot": "Boot Configuration → Secure Boot → Enable Secure Boot: On",
        ca: "Boot Configuration → Secure Boot → Enable Microsoft UEFI CA: On",
        tpm: "Security → TPM 2.0 Security: On",
        iommu: "Virtualization → Enable Intel VT for Direct I/O: On",
      },
    },
  },
  {
    maker: /^(hp|hewlett)/i,
    guide: {
      name: "HP",
      keys: ["Esc", "F10"],
      paths: {
        uefi: "Advanced → Boot Options → Legacy Support: Disabled",
        "secure-boot": "Advanced → Secure Boot Configuration → Secure Boot: Enabled",
        ca: "Advanced → Secure Boot Configuration → Enable MS UEFI CA key: On",
        tpm: "Security → TPM Embedded Security → TPM State: Enabled",
        iommu: "Advanced → System Options → Virtualization Technology for Directed I/O: On",
      },
    },
  },
  {
    maker: /asus/i,
    guide: {
      name: "ASUS",
      keys: ["Del", "F2"],
      paths: {
        uefi: "Advanced Mode (F7) → Boot → CSM → Launch CSM: Disabled",
        "secure-boot": "Advanced Mode (F7) → Boot → Secure Boot → OS Type: Windows UEFI mode",
        ca: "Advanced Mode (F7) → Boot → Secure Boot → Key Management → Install default Secure Boot keys",
        tpm: {
          amd: "Advanced Mode (F7) → Advanced → AMD fTPM configuration → Firmware TPM",
          intel: "Advanced Mode (F7) → Advanced → PCH-FW Configuration → PTT: Enable",
        },
        iommu: {
          amd: "Advanced Mode (F7) → Advanced → AMD CBS → NBIO Common Options → IOMMU: Enabled",
          intel: "Advanced Mode (F7) → Advanced → System Agent (SA) Configuration → VT-d: Enabled",
        },
      },
    },
  },
  {
    maker: /micro-star|^msi/i,
    guide: {
      name: "MSI",
      keys: ["Del"],
      paths: {
        uefi: "Settings → Advanced → Windows OS Configuration → BIOS UEFI/CSM Mode: UEFI",
        "secure-boot": "Settings → Security → Secure Boot → Secure Boot: Enabled",
        ca: "Settings → Security → Secure Boot → Restore Factory Keys",
        tpm: "Settings → Security → Trusted Computing → Security Device Support: Enable",
        iommu: {
          amd: "OC → CPU Features → IOMMU: Enabled",
          intel: "OC → CPU Features → Intel VT-D Tech: Enabled",
        },
      },
    },
  },
  {
    maker: /gigabyte/i,
    guide: {
      name: "Gigabyte",
      keys: ["Del"],
      paths: {
        uefi: "Boot → CSM Support: Disabled",
        "secure-boot": "Boot → Secure Boot → Secure Boot: Enabled",
        ca: "Boot → Secure Boot → Restore Factory Keys",
        tpm: {
          amd: "Settings → Miscellaneous → AMD CPU fTPM: Enabled",
          intel: "Settings → Miscellaneous → Intel Platform Trust Technology (PTT): Enabled",
        },
        iommu: {
          amd: "Settings → Miscellaneous → IOMMU: Enabled",
          intel: "Settings → Miscellaneous → VT-d: Enabled",
        },
      },
    },
  },
  {
    maker: /asrock/i,
    guide: {
      name: "ASRock",
      keys: ["F2", "Del"],
      paths: {
        uefi: "Boot → CSM (Compatibility Support Module) → CSM: Disabled",
        "secure-boot": "Security → Secure Boot → Secure Boot: Enabled",
        ca: "Security → Secure Boot → Install Default Secure Boot Keys",
        tpm: {
          amd: "Advanced → CPU Configuration → AMD fTPM switch: AMD CPU fTPM",
          intel: "Security → Intel Platform Trust Technology: Enabled",
        },
        iommu: {
          amd: "Advanced → AMD CBS → NBIO Common Options → IOMMU: Enabled",
          intel: "Advanced → Chipset Configuration → VT-d: Enabled",
        },
      },
    },
  },
  {
    maker: /microsoft/i,
    guide: {
      name: "Surface",
      keys: ["Vol +"],
      paths: {
        "secure-boot": "Security → Secure Boot → Change configuration → Microsoft & 3rd party CA",
        ca: "Security → Secure Boot → Change configuration → Microsoft & 3rd party CA",
      },
    },
  },
  { bios: /american megatrends|^ami\b/i, guide: AMI },
  {
    bios: /insyde/i,
    guide: {
      name: "Insyde",
      keys: ["F2"],
      paths: {
        uefi: "Boot → Boot Mode: UEFI",
        "secure-boot": "Boot → Secure Boot: Enabled",
        ca: "Security → Restore Secure Boot to Factory Default",
      },
    },
  },
];

/** This PC's BIOS setup as far as the table knows it; null when it does not. */
export function firmwareGuide({ facts }: RentalRead): FirmwareGuide | null {
  const vendor = facts.vendor ?? { bios: "", maker: "", model: "" };
  return (
    GUIDES.find((g) => g.maker?.test(vendor.maker))?.guide ??
    GUIDES.find((g) => g.bios?.test(vendor.bios))?.guide ??
    null
  );
}

/** The menu path to `id` on this PC's firmware; null when the table has none. */
export function biosPath(read: RentalRead, id: BiosId): string | null {
  const path = firmwareGuide(read)?.paths[id];
  if (!path) return null;
  if (typeof path === "string") return path;
  return read.facts.cpu ? path[read.facts.cpu] : null;
}

/** A to-do in Windows: what to do, why, and what the plate shows to set. */
export type WindowsTodo = { id: "games" | "space"; title: string; line: string; setting: [string, string] };

/** What only a Swiff update brings: nothing the owner can do but wait. */
export type Waiting = { id: "gpu" | "image"; setting: [string, string] };

/** Today's words, unchanged: NVIDIA support is being built, so it gets no new copy. */
export const NVIDIA_LINE = "NVIDIA graphics cards come in a later Swiff OS update.";

/** Where rental mode stands on this PC, from what was read: the one thing to do next. */
export type RentalStage =
  | { kind: "reading" }
  | { kind: "unread" }
  /** An install stopped part way: continue it, or undo it. */
  | { kind: "resume"; bios: BiosId[]; todos: WindowsTodo[] }
  | { kind: "windows"; todos: WindowsTodo[]; bios: BiosId[]; waiting: Waiting[] }
  | { kind: "bios"; bios: BiosId[]; waiting: Waiting[] }
  /** Swiff OS's files are on this PC, but Swiff did not sign them: they are not installed. */
  | { kind: "unsigned" }
  /** Only what an update brings is left. */
  | { kind: "almost"; waiting: Waiting[] }
  | { kind: "ready" }
  /** Swiff's key is queued: the next restart shows its blue screen. */
  | { kind: "restart"; code: string; plan?: RentalPlan }
  /** The PC restarted since: only the owner saw whether the blue screen took the code. */
  | { kind: "ask" }
  /** The key was not confirmed: a new code, and one more restart. */
  | { kind: "key" }
  /** Found after the restart, in this start's boot log: Windows started straight after shim, without the key. */
  | { kind: "nokey" }
  /** Back in Windows after a live run in Swiff OS: what it did, once. */
  | { kind: "back"; live: LastLive }
  | { kind: "installed" };

/** The to-dos in Windows, in the owner's words. */
export function windowsTodos(read: RentalRead, targetId: string | null): WindowsTodo[] {
  const todos: WindowsTodo[] = [];
  for (const check of pcChecks(read, targetId)) {
    if (check.state !== "blocked") continue;
    if (check.id === "games" && read.games)
      todos.push({
        id: "games",
        title: `Turn off BitLocker on ${read.games.letter}:`,
        line: "Swiff OS can't read an encrypted drive.",
        setting: [`${read.games.letter}: BitLocker`, "Off"],
      });
    if (check.id === "space")
      todos.push({
        id: "space",
        title: `Free up ${gb(read.need)}`,
        line: choiceGone(read, targetId)
          ? "The drive you picked for Swiff OS isn't there any more. Pick another, or free up space on one drive."
          : `Swiff OS needs ${gb(read.need)} on one drive. Move or delete files, or add a drive.`,
        setting: ["Free space on one drive", gb(read.need)],
      });
  }
  return todos;
}

/** The BIOS settings to change, in the order the setup screen usually has them. */
export function biosTodos(read: RentalRead): BiosId[] {
  return firmwareChecks(read)
    .filter((c) => c.state === "bios")
    .map((c) => c.id as BiosId);
}

/** What only an update brings: support for this graphics card, or Swiff OS's own files. */
export function waitingFor(read: RentalRead, targetId: string | null): Waiting[] {
  const checks = pcChecks(read, targetId);
  const waiting: Waiting[] = [];
  if (checks.some((c) => c.id === "gpu" && c.state === "blocked"))
    waiting.push({ id: "gpu", setting: ["Graphics card", "Update coming"] });
  if (!read.imageRefused && checks.some((c) => c.id === "image" && c.state === "blocked"))
    waiting.push({ id: "image", setting: ["Swiff OS", "Update coming"] });
  return waiting;
}

/** Where rental mode stands: the read's own stage, before any plan on screen. */
export function rentalStage({
  read,
  reading,
  target,
  liveSeen = null,
}: Pick<RentalSetup, "read" | "reading" | "target" | "liveSeen">): RentalStage {
  if (!read) return reading ? { kind: "reading" } : { kind: "unread" };
  if (read.installed) {
    const key = read.key ?? null;
    if (key?.state === "queued") return { kind: "restart", code: key.code };
    if (key?.state === "confirmed") {
      const live = read.lastLive ?? null;
      return live && live.to !== liveSeen ? { kind: "back", live } : { kind: "installed" };
    }
    if (key?.state === "missed") return { kind: "key" };
    if (key?.state === "nokey") return { kind: "nokey" };
    // Restarted since the request, or installed before the app kept track: the owner knows.
    return { kind: "ask" };
  }
  const todos = windowsTodos(read, target);
  const bios = biosTodos(read);
  const waiting = waitingFor(read, target);
  if (read.facts.install) return { kind: "resume", bios, todos };
  if (todos.length) return { kind: "windows", todos, bios, waiting };
  if (bios.length) return { kind: "bios", bios, waiting };
  if (read.imageRefused) return { kind: "unsigned" };
  if (waiting.length) return { kind: "almost", waiting };
  return { kind: "ready" };
}

/** "Turn on Secure Boot and IOMMU", "Turn on IOMMU", "Change 3 BIOS settings". */
export function biosTitle(bios: BiosId[]): string {
  if (bios.length === 1) return BIOS_ASKS[bios[0]!].title;
  const ons = bios.every((id) => BIOS_ASKS[id].title.startsWith("Turn on "));
  if (bios.length === 2 && ons)
    return `Turn on ${BIOS_ASKS[bios[0]!].title.slice(8)} and ${BIOS_ASKS[bios[1]!].title.slice(8)}`;
  return `Change ${bios.length} BIOS settings`;
}

// --- the plan on screen, and its run ------------------------------------------------------

/** What the running step is called: a verb in -ing, in the owner's words, by plan step id. */
export const RUNNING_TITLE: Record<string, string> = {
  check: "Checking the Secure Boot keys",
  bitlocker: "Pausing BitLocker on C:",
  "fast-startup": "Turning off Fast Startup",
  room: "Making room",
  partitions: "Creating Swiff OS's partitions",
  write: "Writing Swiff OS",
  "boot-entry": "Adding Swiff OS to the boot menu",
  "games-clear": "Labelling your games drive",
  games: "Labelling your games drive",
  mok: "Preparing your key code",
  "mok-restart": "Restarting",
  "mok-remove": "Preparing your key code",
  restart: "Restarting",
  labels: "Giving your drives their names back",
  forget: "Finishing up",
  once: "Pointing the next start at Swiff OS",
};

/** An honest hint for a step nothing measures, by plan step id. */
export const STEP_HINT: Record<string, { line: string; short: string }> = {
  check: { line: "Usually under a minute.", short: "Under a minute" },
  room: { line: "This can take a few minutes on a full drive.", short: "Can take a few minutes" },
};
const QUICK = { line: "Usually a few seconds.", short: "A few seconds" };
export const hintOf = (id: string) => STEP_HINT[id] ?? QUICK;

/** The steps a run carries out by itself: all but the restart, which waits for Restart now. */
export const autoSteps = (plan: RentalPlan): PlanStep[] =>
  plan.steps.filter((s) => !s.ops.some((o) => o.op === "restart"));

/** The plan has a restart at its end, which the owner starts. */
export const endsInRestart = (plan: RentalPlan): boolean => autoSteps(plan).length < plan.steps.length;

/** The bytes a step writes, op by op in order: what its progress is measured against. */
export const writesOf = (step: PlanStep): number[] =>
  step.ops.flatMap((o) => (o.op === "write" ? [o.bytes] : []));

/** What the screen shows: the read's stage, or the plan on screen and how its run goes. */
export type RentalScreen =
  | RentalStage
  /** The plan, before its one OK. */
  | { kind: "preview"; plan: RentalPlan }
  /** Windows' administrator prompt is up. */
  | { kind: "elevating"; plan: RentalPlan }
  | { kind: "running"; plan: RentalPlan; step: PlanStep; index: number }
  | { kind: "restarting"; code: string | null; plan?: RentalPlan }
  /** A step did not finish: what happened, and the one way on. */
  | { kind: "failed"; plan: RentalPlan; step: PlanStep | null; error: string };

/** Where the rental screen is now: the run beats the preview, the preview beats the read. */
export function rentalScreen(setup: RentalSetup): RentalScreen {
  const { preview: plan, run } = setup;
  if (plan) {
    switch (run.status) {
      case "starting":
        return { kind: "elevating", plan };
      case "running": {
        const index = plan.steps.findIndex((s) => run.steps[s.id] === "running");
        const at =
          index >= 0
            ? index
            : Math.max(
                0,
                plan.steps.findIndex((s) => !run.steps[s.id]),
              );
        return { kind: "running", plan, step: plan.steps[at]!, index: at };
      }
      case "failed":
      case "stopped": {
        const step = plan.steps.find((s) => s.id === run.failed?.step) ?? null;
        return { kind: "failed", plan, step, error: run.failed?.error ?? "" };
      }
      case "restarting":
        return { kind: "restarting", code: plan.mok?.code ?? null, plan };
      case "done":
        if (endsInRestart(plan)) return { kind: "restart", code: plan.mok?.code ?? "", plan };
        break;
      default:
        return { kind: "preview", plan };
    }
  }
  if (run.status === "restarting") return { kind: "restarting", code: setup.read?.key?.code ?? null };
  return rentalStage(setup);
}

/** Which of the three steps is the owner's now: 0 get the PC ready, 1 install, 2 confirm the key, 3 all done. */
export function rentalStepAt(setup: RentalSetup): number {
  const s = rentalScreen(setup);
  switch (s.kind) {
    case "installed":
    case "back":
      return 3;
    case "ask":
    case "key":
    case "nokey":
      return 2;
    case "restart":
    case "restarting":
      // The install's own restart is its last step; any later one is for the key alone.
      return s.plan?.kind === "install" ? 1 : 2;
    case "failed":
      // Space and a BIOS setting are the PC's to get ready, whatever step found them.
      if (["space", "bios"].includes(failureOf(setup, s).kind)) return 0;
      return s.plan.kind === "mok" || s.plan.kind === "unkey" ? 2 : 1;
    case "preview":
    case "elevating":
    case "running":
      return s.plan.kind === "mok" || s.plan.kind === "unkey" ? 2 : 1;
    case "ready":
    case "resume":
      return 1;
    default:
      return 0;
  }
}

/** Rental mode is ready to go live: installed, and its key confirmed. */
export const rentalReady = (setup: RentalSetup): boolean => {
  const kind = rentalStage(setup).kind;
  return kind === "installed" || kind === "back";
};

/**
 * Go live and Get paid open only once rental mode is ready: before that they
 * could only send the owner back to it. A PC already live keeps them, and
 * development builds that share this Windows desktop (`share`) go live without it.
 */
export function stepLocked(
  step: string,
  view: { rental: RentalSetup; live: { kind: string } },
  share = false,
): boolean {
  return (
    (step === "live" || step === "paid") && !share && view.live.kind === "off" && !rentalReady(view.rental)
  );
}

/** Where rental mode stands, in a few words: the rail's line under it. */
export function rentalLine(setup: RentalSetup): string {
  const s = rentalScreen(setup);
  switch (s.kind) {
    case "reading":
      return "Checking this PC";
    case "unread":
      return "Check didn't finish";
    case "resume":
      return "Install didn't finish";
    case "windows":
      return "Not ready";
    case "bios":
      return s.bios.length === 1 ? "1 BIOS setting" : `${s.bios.length} BIOS settings`;
    case "unsigned":
      return "Files didn't check out";
    case "almost":
      return s.waiting.some((w) => w.id === "gpu") ? "Not on NVIDIA yet" : "Waiting for an update";
    case "ready":
    case "preview":
      return "Ready to install";
    case "elevating":
      return s.plan.kind === "install" ? "Installing" : "Waiting for Windows";
    case "running": {
      if (s.plan.kind !== "install") return s.plan.kind === "uninstall" ? "Removing" : "Working";
      const p = setup.run.progress;
      return p && p.total > 0 ? `Installing, ${Math.floor((p.done / p.total) * 100)}%` : "Installing";
    }
    case "restart":
      return "Ready to restart";
    case "restarting":
      return "Restarting";
    case "failed":
      return failureOf(setup, s).rail;
    case "ask":
    case "key":
      return "Confirm the key";
    case "nokey":
      return "Key not confirmed";
    case "installed":
    case "back":
      return "Ready";
  }
}

// --- when a step stops ----------------------------------------------------------------------
//
// Every failure says what happened, why in one plain sentence, what is
// different on the PC so far (from the steps that finished), and the one thing
// to do next. Windows' own words wait behind "What happened, in detail".

export type FailureKind = "admin" | "bios" | "write" | "space" | "removal" | "restart" | "image" | "unknown";

export type Failure = {
  kind: FailureKind;
  title: string;
  why: string;
  /** What is different on this PC now: the safety fact. */
  changed: string;
  /** The one action: ask Windows again, try again, use another drive, check again, or send details. */
  action: "ask" | "again" | "use" | "check" | "send" | "restart";
  label: string;
  /** The rail's line. */
  rail: string;
  /** The plate: what stopped and when (its caption), and how far it got (under the dial). */
  what: string;
  at: string;
  far: string;
  /** For a BIOS setting the administrator check found missing: which one. */
  bios?: BiosId;
};

/** The BIOS setting the install's administrator check found missing, from its error; null for any other error. */
export function checkBios(error: string): BiosId | null {
  if (/Secure Boot is off/i.test(error)) return "secure-boot";
  if (/not supported on this platform/i.test(error)) return "uefi";
  if (/TPM is not ready/i.test(error)) return "tpm";
  if (/does not trust/i.test(error)) return "ca";
  return null;
}

/** What a finished step left changed on the PC, in the owner's words; null for the ones that leave nothing to know. */
function changeOf(plan: RentalPlan, step: PlanStep): string | null {
  const room = plan.target?.kind === "shrink" ? plan.target.letter : null;
  if (plan.kind === "uninstall")
    return (
      {
        "boot-entry": "Swiff OS is off the boot menu.",
        partitions: "Swiff OS is off the disk.",
      }[step.id] ?? null
    );
  return (
    {
      bitlocker: "BitLocker on C: is paused for the next few restarts.",
      "fast-startup": "Fast Startup is off.",
      room: room ? `${room}: is already ${gb(SWIFF_GB)} smaller.` : null,
      "boot-entry": "Swiff OS is in the boot menu, after Windows.",
      mok: "Swiff's key is queued for the next restart.",
    }[step.id] ?? null
  );
}
/** Swiff OS's size on the disk, in whole gigabytes as the owner reads it. */
const SWIFF_GB = 24 * 1024 ** 3;

/** The sentences for what the steps that finished changed, or that nothing did. */
export function changedSoFar(plan: RentalPlan, run: RentalRun): string {
  const changes = plan.steps
    .filter((s) => run.steps[s.id] === "done")
    .flatMap((s) => changeOf(plan, s) ?? []);
  if (plan.kind === "uninstall") return ["Windows starts as normal.", ...changes].join(" ");
  if (!changes.length) return "Nothing on this PC has changed.";
  return [...changes, "Windows and your files are untouched."].join(" ");
}

/** 4,123,456,789 bytes → "4.1". */
const gbOne = (bytes: number) => (bytes / 1e9).toFixed(1);

/** One of Swiff OS's files (image-set.cjs), in the owner's words: Boot, Root or Verity. */
export function fileName(file: string): string {
  if (/\.esp\.raw$/.test(file)) return "Boot";
  if (/-verity\.raw$/.test(file)) return "Verity";
  if (/\.root-[\w-]+\.raw$/.test(file)) return "Root";
  return file;
}

const PAST = { copying: "copied", writing: "written", checking: "checked" } as const;
/** A pass in its own file's bytes: "2.1 of 8.6 GB copied". */
export const passBytes = (p: WritePass) => `${gbOne(p.done)} of ${gbOne(p.total)} GB ${PAST[p.doing]}`;

/** A drive that has room for Swiff OS, other than the one that just ran out: the way on from "not enough space". */
export function otherRoom(read: RentalRead | null, failed: string | null): RentalTarget | null {
  return read?.targets.find((t) => t.kind !== "shrink" || t.letter !== failed) ?? null;
}

/** Which failure this is, and everything it says. */
export function failureOf(setup: RentalSetup, s: Extract<RentalScreen, { kind: "failed" }>): Failure {
  const { plan, step, error } = s;
  const { run, read } = setup;
  const stoppedAt = run.endedAt ? clock(run.endedAt) : "";
  const index = step ? plan.steps.indexOf(step) + 1 : 0;
  const installing = plan.kind === "install";
  const failedStep = run.failed?.step ?? "";
  const far = `at step ${index} of ${plan.steps.length}`;
  const stopped = (what: string, rest: Omit<Failure, "what" | "at" | "far">, how = far): Failure => ({
    ...rest,
    what,
    at: stoppedAt ? `Stopped at ${stoppedAt}` : "Stopped",
    far: how,
  });

  if (failedStep === "elevate")
    return {
      kind: "admin",
      title: "Windows didn't give permission",
      why: "The install needs administrator rights, and the Windows prompt was declined or closed.",
      changed: "Nothing on this PC has changed.",
      action: "ask",
      label: "Ask again",
      rail: "Needs permission",
      what: installing ? "Install" : "Windows",
      at: "Not started",
      far: "for permission",
    };
  if (failedStep === "restart")
    return {
      kind: "restart",
      title: "The PC didn't restart",
      why: "Windows didn't start the restart.",
      changed:
        "Swiff's key is queued, so the blue screen still comes on the next restart, from here or the Start menu.",
      action: "restart",
      label: "Restart now",
      rail: "Restart didn't start",
      what: "Restart",
      at: "Not started",
      far: "not started",
    };
  const sent = run.reportedAt !== null;
  // The administrator side refused Swiff OS's files (image-set.cjs): not signed by Swiff, or not the ones listed.
  if (/image set/i.test(error))
    return stopped(installing ? "Install" : "Key", {
      kind: "image",
      title: "Swiff OS's files didn't pass the check",
      why: "The Swiff OS files on this PC aren't the ones Swiff signed, so Swiff didn't use them.",
      changed: changedSoFar(plan, run),
      action: sent ? "again" : "send",
      label: sent ? "Try again" : "Send details to Swiff",
      rail: "Files didn't check out",
    });
  const bios = step?.id === "check" ? checkBios(error) : null;
  if (bios)
    return {
      kind: "bios",
      bios,
      title: BIOS_ASKS[bios].title,
      why:
        bios === "ca"
          ? "Swiff checked the BIOS's Secure Boot keys as administrator: they don't allow the Microsoft 3rd-party UEFI CA, which signs Swiff OS's start."
          : "Swiff checked this PC as administrator, and the BIOS has this setting off.",
      changed: "Nothing on this PC has changed. Change the setting, then check again.",
      action: "check",
      label: "Check again",
      rail: "BIOS setting",
      what: "In the BIOS",
      at: stoppedAt ? `Checked at ${stoppedAt}` : "",
      far: "",
    };
  const letter = plan.target?.kind === "shrink" ? plan.target.letter : "C";
  if ((step?.id === "room" || step?.id === "check") && /shrink/i.test(error)) {
    const other = otherRoom(read, letter);
    return {
      kind: "space",
      title: `Not enough space on ${letter}:`,
      why: `Files were added since the check, so there isn't room for Swiff OS on ${letter}:.`,
      changed: changedSoFar(plan, run),
      action: other ? "use" : "check",
      label: other
        ? other.kind === "shrink"
          ? `Use ${other.letter}: instead`
          : `Use disk ${other.disk} instead`
        : "Check again",
      rail: "Not enough space",
      what: "Space",
      at: stoppedAt ? `Checked at ${stoppedAt}` : "",
      far: "",
    };
  }
  if (plan.kind === "uninstall")
    return stopped("Removing", {
      kind: "removal",
      title: "Removing rental mode stopped",
      why:
        step?.id === "room"
          ? `Swiff OS's space couldn't be given back to ${install(read)?.shrink?.letter ?? "C"}:.`
          : `It stopped while ${(RUNNING_TITLE[step?.id ?? ""] ?? step?.title ?? "removing").toLowerCase()}.`,
      changed: `${changedSoFar(plan, run)}${step?.id === "room" ? ` The ${gb(SWIFF_GB)} stays unused until this finishes.` : ""}`,
      action: "again",
      label: "Try again",
      rail: "Removal stopped",
    });
  if (step?.id === "write") {
    const p = run.progress?.id === "write" ? run.progress.pass : null;
    return stopped(
      "Writing Swiff OS",
      {
        kind: "write",
        title: "Writing Swiff OS stopped",
        why: p
          ? `The drive reported an error while ${p.doing} ${p.name}, after ${gbOne(p.done)} of ${gbOne(p.total)} GB.`
          : "The drive reported an error while Swiff OS was written.",
        changed: `${changedSoFar(plan, run)} Trying again writes Swiff OS from the start.`,
        action: "again",
        label: "Try again",
        rail: installing ? "Install stopped" : "Stopped",
      },
      p ? `${p.name}, at ${gbOne(p.done)} of ${gbOne(p.total)} GB` : far,
    );
  }
  const running = (RUNNING_TITLE[step?.id ?? ""] ?? step?.title ?? "working").replace(/^\w/, (c) =>
    c.toLowerCase(),
  );
  return stopped(installing ? "Install" : "Key", {
    kind: "unknown",
    title: installing
      ? "The install stopped"
      : plan.kind === "mok"
        ? "Confirming the key stopped"
        : "That stopped",
    why: `It stopped while ${running}, and Swiff doesn't know this error yet.`,
    changed:
      installing || index > 1
        ? `Nothing after that step ran. ${changedSoFar(plan, run).replace("Nothing on this PC has changed.", "Windows and your files are untouched.")}`
        : changedSoFar(plan, run),
    action: sent ? "again" : "send",
    label: sent ? "Try again" : "Send details to Swiff",
    rail: installing ? "Install stopped" : "Stopped",
  });
}

const install = (read: RentalRead | null) => read?.facts.install ?? null;
