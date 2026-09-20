import type { ReactNode } from "react";

/** An error the user has to act on — capture denied, answer failed. */
export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}
