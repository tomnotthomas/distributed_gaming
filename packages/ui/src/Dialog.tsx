import type { ReactNode } from "react";

type Props = { title: string; children: ReactNode; actions: ReactNode };

/**
 * A modal over the running session — the owner taking their machine back is the
 * only thing that earns one. Native <dialog> is not used because this renders
 * inside the stream's own stacking context, not the top layer.
 */
export function Dialog({ title, children, actions }: Props) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog glass" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
