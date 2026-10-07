// Types for esp-file.cjs, so its tests can use it.

export function writeRootFile(
  disk: {
    read(offset: number, length: number): Buffer;
    write(writes: { offset: number; bytes: Buffer }[]): void;
  },
  base: number,
  name: string,
  content: Buffer,
  now?: Date,
): void;
