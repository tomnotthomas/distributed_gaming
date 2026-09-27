import { forwardRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useModal } from "../../lib/useModal";
import { IconButton } from "../IconButton";
import "./Sheet.css";

type Props = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onDismiss: () => void;
  /** Accessible name of the close button, e.g. "Close". */
  closeLabel: string;
};

/**
 * A panel that slides in from the right to explain something without leaving
 * the screen. Same focus rules as Dialog; the props land on the panel.
 */
export const Sheet = forwardRef<HTMLElement, Props>(function Sheet(
  { title, children, footer, onDismiss, closeLabel, className, ...rest },
  ref,
) {
  const { titleId, backdropProps, panelProps } = useModal(ref, onDismiss);
  return (
    <div className="sheet-backdrop" {...backdropProps}>
      <aside {...panelProps} className={cx("sheet", className)} {...rest}>
        <header className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          <IconButton icon="close" label={closeLabel} size="sm" onClick={onDismiss} />
        </header>
        <div className="sheet-body ui-scroll">{children}</div>
        {footer ? <footer className="sheet-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
});
