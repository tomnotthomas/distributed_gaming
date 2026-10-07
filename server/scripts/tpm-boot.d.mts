// Types for tpm-boot.mjs, for the TypeScript tests that measure its boot.

/** What one boot changes from the golden one (bootEvents in tpm-boot.mjs). */
export type Boot = {
  firmware?: string;
  secureBoot?: number;
  extraApp?: string | null;
  apps?: boolean;
  uki?: string;
  dmaOff?: boolean;
  credential?: boolean;
  sysext?: boolean;
  setupMode?: boolean;
  ownerDbKey?: boolean;
};
export type BootEvent = { pcr: number; type: number; data: Buffer; measured: Buffer };

export function sha256(...parts: Buffer[]): Buffer;
export function bootEvents(boot: Boot): { events: BootEvent[]; phases: string[] };
export function eventLog(boot: Boot): Buffer;
export function bootApplications(boot: Boot): string[];
export function secureBootAuthorities(boot: Boot): string[];
