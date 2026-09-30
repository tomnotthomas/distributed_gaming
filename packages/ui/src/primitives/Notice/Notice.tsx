import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import type { Tone } from "../../lib/tone";
import "./Notice.css";

type Props = HTMLAttributes<HTMLParagraphElement> & {
  children: ReactNode;
  /** `danger` for an error the user has to act on; `neutral` for information. */
  tone?: Extract<Tone, "danger" | "neutral">;
};

/** A message in the flow of the page — capture denied, answer failed. */
export function Notice({ children, tone = "danger", className, ...rest }: Props) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cx("notice", className)}
      {...rest}
    >
      {children}
    </p>
  );
}
