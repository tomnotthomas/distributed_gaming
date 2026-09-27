import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import "./Divider.css";

type Props = HTMLAttributes<HTMLHRElement> & {
  /** Fade the rule out toward one or both ends. */
  fade?: "end" | "both";
};

export function Divider({ fade, className, ...rest }: Props) {
  return <hr data-fade={fade} className={cx("divider", className)} {...rest} />;
}
