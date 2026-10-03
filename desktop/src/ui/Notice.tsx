import type { ReactNode } from "react";
import { Glyph, type GlyphName } from "./Glyph";

/** A ruled line of something the owner should know: a refused key, a time that passed. */
export function Notice({ children, icon = "info" }: { children: ReactNode; icon?: GlyphName }) {
  return (
    <div className="hnote" role="status">
      <Glyph name={icon} />
      <span>{children}</span>
    </div>
  );
}
