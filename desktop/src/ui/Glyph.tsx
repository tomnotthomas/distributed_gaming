// Hairline glyphs at the weight of the rules around them. Decorative: whatever
// carries one supplies the accessible name.

const PATHS = {
  arrow: "M5 12h13M13 7l5 5-5 5",
  play: "M9 6.5v11l8.5-5.5z",
  pause: "M9.5 7v10M14.5 7v10",
  block: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM6.4 6.4l11.2 11.2",
  bell: "M7 16.5V11a5 5 0 0 1 10 0v5.5l1.5 1.5h-13zM10.5 20h3",
  warning: "M12 4.5 20.5 19h-17zM12 10v4.5M12 16.6v.4",
  undo: "M8 9H15a4.5 4.5 0 0 1 0 9h-4M11 5.5 7.5 9l3.5 3.5",
  refresh: "M18.5 12a6.5 6.5 0 1 1-2-4.7M18.5 5v4h-4",
  check: "M6 12.5l4 4 8-9",
  lock: "M7 11V8.5a5 5 0 0 1 10 0V11M6 11h12v9H6zM12 14.5v2.5",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 7.5V12l3 2",
  download: "M12 5v10M7.5 10.5 12 15l4.5-4.5M6 19h12",
  info: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v5M12 15.6v.4",
  offline: "M7 17h10.5a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 7.3 9 4 4 0 0 0 7 17zM4 4l16 16",
  close: "M7 7l10 10M17 7 7 17",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 18 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
