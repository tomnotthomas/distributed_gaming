type Props = {
  initial: string;
  /** 22 in the owner stack, 32 in the header, 72 on the profile. */
  size?: number;
  /** `live` is the ring that means "your machine is sharing right now". */
  ring?: "live" | "idle" | "none";
};

/**
 * The initial-in-a-circle used at three sizes. Above 64px it takes the gradient
 * and glow: at profile size a flat fill reads as a placeholder rather than you.
 */
export function Avatar({ initial, size = 32, ring = "none" }: Props) {
  return (
    <span
      className={size >= 64 ? "avatar avatar-lg" : "avatar"}
      data-ring={ring}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initial}
    </span>
  );
}
