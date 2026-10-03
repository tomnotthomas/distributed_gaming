// The tray icon's pixels, drawn in code: a ring with a dot in it. Kept apart
// from main.cjs so the drawing can be checked without Electron.

const TRAY_ICON_SIZE = 32;

/** BGRA pixels, black at each pixel's alpha, `size` × `size`. */
function trayIconPixels(size = TRAY_ICON_SIZE) {
  const pixels = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.max(0, 1 - Math.abs(d - 12.5) / 1.4);
      const dot = Math.max(0, Math.min(1, 6.5 - d));
      const alpha = Math.round(255 * Math.min(1, ring + dot));
      // `alpha << 24` is negative from 128 up; `>>> 0` keeps it an unsigned 32-bit value.
      pixels.writeUInt32LE((alpha << 24) >>> 0, (y * size + x) * 4);
    }
  }
  return pixels;
}

module.exports = { TRAY_ICON_SIZE, trayIconPixels };
