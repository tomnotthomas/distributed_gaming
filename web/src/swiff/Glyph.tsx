// Hairline glyphs for the Paper Band chrome, drawn at the weight of the rules
// around them. Decorative: whatever carries them supplies the accessible name.

const PATHS = {
  play: "M9 6.5v11l8.5-5.5z",
  arrow: "M7 17 17 7M9 7h8v8",
  lock: "M7 11V8.5a5 5 0 0 1 10 0V11M6 11h12v9H6zM12 14.5v2.5",
  close: "M7 7l10 10M17 7 7 17",
  back: "M14.5 6 8.5 12l6 6",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 7.5V12l3 2",
  download: "M12 5v10M7.5 10.5 12 15l4.5-4.5M6 19h12",
  card: "M4 6.5h16v11H4zM4 10h16M7 14.5h4",
  crew: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M16 11a2.5 2.5 0 1 0 0-5M17.5 14.6c1.7.4 2.8 1.8 3.1 4.4",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 22 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
