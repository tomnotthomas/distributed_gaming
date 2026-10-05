// What the agent keeps across its own reset reboot: that it took the machine off
// offer itself, and the owner's share-until to offer it again with. Without it,
// a machine found off offer at boot is one its owner stopped sharing.
//
// And the boot a renter was last served in, with their session: an agent that
// starts in that same boot (systemd restarted it, the reboot never happened) is
// on a PC that is not clean yet.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Resume = { until: number | null };

export type Served = { bootId: string; sessionId: string };

export type ResumeStore = {
  save(resume: Resume): Promise<void>;
  /** The saved resume; null when none was saved. It stays saved until cleared. */
  read(): Promise<Resume | null>;
  clear(): Promise<void>;
  /** Note that session `sessionId` is served in boot `bootId`, before anything of theirs runs. */
  markServed(served: Served): Promise<void>;
  /** The boot a renter was last served in, and their session; null when none is noted. */
  servedBoot(): Promise<Served | null>;
  forgetServed(): Promise<void>;
};

export function fileResumeStore(stateDir: string): ResumeStore {
  const path = join(stateDir, "resume.json");
  const servedPath = join(stateDir, "served-boot");
  /** Written whole or not at all: the reboot may come at any moment after. */
  const write = async (file: string, text: string) => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, text, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  return {
    save: (resume) => write(path, JSON.stringify(resume)),
    read: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return null;
      }
      try {
        const { until } = JSON.parse(text) as { until?: unknown };
        return { until: typeof until === "number" && Number.isFinite(until) ? until : null };
      } catch {
        return null;
      }
    },
    clear: () => rm(path, { force: true }),
    markServed: ({ bootId, sessionId }) => write(servedPath, `${bootId}\n${sessionId}\n`),
    servedBoot: async () => {
      const [bootId, sessionId] = (await readFile(servedPath, "utf8").catch(() => "")).split("\n");
      return bootId && sessionId ? { bootId, sessionId } : null;
    },
    forgetServed: () => rm(servedPath, { force: true }),
  };
}
