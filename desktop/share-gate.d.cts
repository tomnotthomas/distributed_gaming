// Types for share-gate.cjs, so the renderer's tests can check the rule.

export function windowsShareAllowed(options: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): boolean;
