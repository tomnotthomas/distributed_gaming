import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./EmptyState.css";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** The one thing to do about it. */
  action?: ReactNode;
};

/** Nothing to show, said plainly, with the way out. */
export function EmptyState({ icon, title, body, action, className, ...rest }: Props) {
  return (
    <div className={cx("empty-state", className)} {...rest}>
      {icon}
      <h2 className="empty-state-title">{title}</h2>
      {body ? <p className="empty-state-body">{body}</p> : null}
      {action}
    </div>
  );
}
