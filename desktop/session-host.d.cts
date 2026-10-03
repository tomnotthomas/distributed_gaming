// Types for session-host.cjs, so the renderer's tests can check it.

import type { SessionHost, StreamerCommand, StreamerEvent, StreamerInit } from "./src/handoff";

export const SERVICE_PIPE: string;
export function lineReader(
  onLine: (value: Record<string, unknown>) => void,
): (chunk: Buffer | string) => void;
export function streamerEvent(value: unknown): StreamerEvent | null;
export function streamerInit(init: unknown): StreamerInit;
export function streamerCommand(command: unknown): StreamerCommand | null;

type Spawned = {
  stdin: { write(data: string): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "exit" | "error", listener: (...args: any[]) => void): void;
  once(event: "exit", listener: () => void): void;
  kill(): void;
};
type Pipe = {
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  write(data: string): void;
  destroy(): void;
};

export function localHost(options: {
  command: { file: string; args: string[] };
  env?: Record<string, string | undefined>;
  spawnProcess?: (file: string, args: string[], options: unknown) => Spawned;
}): SessionHost & { kind: "local" };
export function serviceHost(options?: { connect?: () => Pipe }): SessionHost & { kind: "renter" };
export function serviceInstalled(options?: { platform?: string; connect?: () => Pipe }): Promise<boolean>;
