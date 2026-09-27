import type { SVGAttributes } from "react";

/**
 * Phosphor glyphs the prototypes use, on a 256 grid. The keyboard, mouse and
 * gamepad are the filled variants the profile already ships; the rest are the
 * prototypes' regular weight.
 */
const PATHS = {
  play: "M232.4 114.5 88.3 26.4a16 16 0 0 0-16.2-.3A15.9 15.9 0 0 0 64 40v176a15.9 15.9 0 0 0 8.1 13.9 16 16 0 0 0 16.2-.3l144.1-88.1a15.9 15.9 0 0 0 0-27Z",
  "arrow-left": "M224 128a8 8 0 0 1-8 8H59.3l58.4 58.3a8 8 0 0 1-11.4 11.4l-72-72a8 8 0 0 1 0-11.4l72-72a8 8 0 0 1 11.4 11.4L59.3 120H216a8 8 0 0 1 8 8Z",
  "caret-down": "M213.7 101.7l-80 80a8 8 0 0 1-11.4 0l-80-80a8 8 0 0 1 11.4-11.4L128 164.7l74.3-74.4a8 8 0 0 1 11.4 11.4Z",
  clock: "M128 40a96 96 0 1 0 96 96 96.1 96.1 0 0 0-96-96Zm0 176a80 80 0 1 1 80-80 80.1 80.1 0 0 1-80 80Zm48-80a8 8 0 0 1-8 8h-40a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v48h32a8 8 0 0 1 8 8Z",
  keyboard: "M224 48H32a16 16 0 0 0-16 16v128a16 16 0 0 0 16 16h192a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16ZM56 88h16v16H56Zm40 0h16v16H96Zm40 0h16v16h-16Zm40 0h16v16h-16ZM56 128h16v16H56Zm40 0h16v16H96Zm40 0h16v16h-16Zm40 0h16v16h-16ZM72 168h112v16H72Z",
  mouse: "M144 16.5V96h64V96a80.1 80.1 0 0 0-64-79.5ZM112 16.5A80.1 80.1 0 0 0 48 96h64ZM48 112v48a80 80 0 0 0 160 0v-48Z",
  gamepad: "M176 56H80a72 72 0 0 0 0 144h96a72 72 0 0 0 0-144Zm-40 80H88v24a8 8 0 0 1-16 0v-24H48a8 8 0 0 1 0-16h24V96a8 8 0 0 1 16 0v24h48a8 8 0 0 1 0 16Zm40 24a12 12 0 1 1 12-12 12 12 0 0 1-12 12Zm16-40a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z",
  close: "M205.7 194.3a8.1 8.1 0 0 1-11.4 11.4L128 139.3l-66.3 66.4a8.1 8.1 0 0 1-11.4-11.4l66.4-66.3-66.4-66.3a8.1 8.1 0 0 1 11.4-11.4l66.3 66.4 66.3-66.4a8.1 8.1 0 0 1 11.4 11.4L139.3 128Z",
  download: "M224 152v56a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16v-56a8 8 0 0 1 16 0v56h160v-56a8 8 0 0 1 16 0Zm-101.7 5.7a8.1 8.1 0 0 0 11.4 0l40-40a8.1 8.1 0 0 0-11.4-11.4L136 132.7V40a8 8 0 0 0-16 0v92.7l-26.3-26.4a8.1 8.1 0 0 0-11.4 11.4Z",
  check: "M229.7 77.7l-128 128a8.1 8.1 0 0 1-11.4 0l-56-56a8.1 8.1 0 0 1 11.4-11.4L96 188.7 218.3 66.3a8.1 8.1 0 0 1 11.4 11.4Z",
  shield: "M208 40H48a16 16 0 0 0-16 16v56c0 52.7 25.5 84.6 46.9 102.1 23 18.9 46 25.3 47 25.6a8 8 0 0 0 4.2 0c1-.3 24-6.7 47-25.6C198.5 196.6 224 164.7 224 112V56a16 16 0 0 0-16-16Zm0 72c0 37.1-13.7 67.2-40.7 89.4A129.3 129.3 0 0 1 128 223.9a128.3 128.3 0 0 1-38.9-22.2C61.9 179.4 48 149.2 48 112V56h160Z",
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

type Props = Omit<SVGAttributes<SVGSVGElement>, "name"> & {
  name: IconName;
  size?: number;
  /** Without a label the glyph is decoration and hidden from assistive tech. */
  label?: string;
};

export function Icon({ name, size = 18, label, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
