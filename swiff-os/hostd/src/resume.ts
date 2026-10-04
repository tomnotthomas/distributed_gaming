// The one thing the agent keeps across its own reset reboot: that it took the
// machine off offer itself, and the owner's share-until to offer it again with.
// Without it, a machine found off offer at boot is one its owner stopped sharing.
// It names the boot it was saved in: found in that same boot, the reboot never
// happened, and the machine is not clean yet.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Resume = { until: number | null; bootId: string };

export type ResumeStore = {
  save(resume: Resume): Promise<void>;
  /** The saved resume, removed as it is read; null when none was saved. */
  take(): Promise<Resume | null>;
};

export function fileResumeStore(stateDir: string): ResumeStore {
  const path = join(stateDir, "resume.json");
  return {
    save: async (resume) => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      // Written whole or not at all: the reboot may come at any moment after.
      await writeFile(`${path}.tmp`, JSON.stringify(resume), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    },
    take: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return null;
      }
      await rm(path, { force: true });
      try {
        const { until, bootId } = JSON.parse(text) as { until?: unknown; bootId?: unknown };
        if (typeof bootId !== "string") return null;
        return { until: typeof until === "number" && Number.isFinite(until) ? until : null, bootId };
      } catch {
        return null;
      }
    },
  };
}
