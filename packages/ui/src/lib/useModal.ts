import { useEffect, useId, useImperativeHandle, useRef } from "react";
import type { ForwardedRef, MouseEvent, RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

/**
 * Modal focus for Dialog and Sheet: on open, focus moves to the first control
 * inside the panel (or the panel itself); Tab and Shift+Tab wrap inside it;
 * Escape calls onDismiss when there is one; on close, focus returns to whatever
 * held it before, so a keyboard user lands where they left off.
 */
function useFocusTrap(panel: RefObject<HTMLElement>, onDismiss?: () => void) {
  // Read the latest callback without re-running the effect, which would
  // re-steal focus on every parent render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    (focusables(root)[0] ?? root).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismiss.current) {
        event.preventDefault();
        dismiss.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      before?.focus?.();
    };
  }, [panel]);
}

/**
 * Everything Dialog and Sheet share: the panel ref (also exposed through the
 * component's forwarded ref), the focus trap, the title id the panel is
 * labelled by, and a backdrop that dismisses only when clicked itself.
 */
export function useModal<T extends HTMLElement>(forwarded: ForwardedRef<T>, onDismiss?: () => void) {
  const panel = useRef<T>(null);
  useImperativeHandle(forwarded, () => panel.current!);
  useFocusTrap(panel, onDismiss);
  const titleId = useId();
  return {
    titleId,
    backdropProps: {
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (event.target === event.currentTarget) onDismiss?.();
      },
    },
    panelProps: {
      ref: panel,
      role: "dialog",
      "aria-modal": true,
      "aria-labelledby": titleId,
      tabIndex: -1,
    } as const,
  };
}
