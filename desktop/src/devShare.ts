/// <reference types="vite/client" />
// Sharing the owner's Windows desktop is for development only (share-gate.cjs
// is main's half). `vite build` runs in production mode, where DEV is false, so
// every path behind this constant is dropped from the bundle hosts download.

export const WINDOWS_SHARE: boolean =
  import.meta.env.DEV && import.meta.env.VITE_SWIFF_DEV_WINDOWS_SHARE === "1";
