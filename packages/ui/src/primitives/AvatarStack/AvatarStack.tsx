import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { Avatar } from "../Avatar";
import "./AvatarStack.css";

type Person = { initial: string; hue?: string };

type Props = HTMLAttributes<HTMLDivElement> & {
  people: readonly Person[];
  /** Avatars shown before the rest collapse into "+N". */
  max?: number;
  size?: number;
  /** What the group is, e.g. "Owners: m0th, Kai and 2 more". */
  label: string;
};

/** Overlapping avatars with an overflow count. */
export function AvatarStack({ people, max = 3, size = 22, label, className, ...rest }: Props) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div role="img" aria-label={label} className={cx("avatar-stack", className)} {...rest}>
      {shown.map((person, i) => (
        <Avatar key={i} initial={person.initial} hue={person.hue} size={size} aria-hidden="true" />
      ))}
      {extra > 0 ? (
        <span className="avatar-stack-more" aria-hidden="true" style={{ height: size, minWidth: size }}>
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
