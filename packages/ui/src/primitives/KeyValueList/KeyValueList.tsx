import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./KeyValueList.css";

export type KeyValueRow = {
  term: ReactNode;
  value: ReactNode;
  /** A total: bolder, with a rule above it. */
  emphasis?: boolean;
  /** A sub-line of the row above. */
  indent?: boolean;
  muted?: boolean;
};

type Props = HTMLAttributes<HTMLDListElement> & { rows: readonly KeyValueRow[] };

/** Term on the left, number on the right: how a figure was reached. */
export function KeyValueList({ rows, className, ...rest }: Props) {
  return (
    <dl className={cx("kv", className)} {...rest}>
      {rows.map((row, i) => (
        <div
          key={i}
          className="kv-row"
          data-emphasis={row.emphasis ? "" : undefined}
          data-indent={row.indent ? "" : undefined}
          data-muted={row.muted ? "" : undefined}
        >
          <dt>{row.term}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
