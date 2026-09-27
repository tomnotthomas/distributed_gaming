import { forwardRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useModal } from "../../lib/useModal";
import "./Dialog.css";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  /**
   * Escape and a backdrop click call it. Leave it out when the choice is
   * mandatory — the owner taking their machine back has no "never mind".
   */
  onDismiss?: () => void;
};

/**
 * A modal. Native <dialog> is not used because this renders inside the
 * stream's own stacking context, not the top layer. `className` and the other
 * props land on the panel, not the backdrop.
 */
export const Dialog = forwardRef<HTMLDivElement, Props>(function Dialog(
  { title, children, actions, onDismiss, className, ...rest },
  ref,
) {
  const { titleId, backdropProps, panelProps } = useModal(ref, onDismiss);
  return (
    <div className="dialog-backdrop" {...backdropProps}>
      <div {...panelProps} className={cx("dialog glass", className)} {...rest}>
        <div className="dialog-title" id={titleId}>
          {title}
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
});
