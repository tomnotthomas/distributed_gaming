// One import gives consumers tokens, document styles and every component.
// Order matters: tokens → base/motion → primitives → patterns, so a pattern's
// CSS can refine the primitives it is built from.
import "./tokens/colors.css";
import "./tokens/typography.css";
import "./tokens/spacing.css";
import "./styles/base.css";
import "./styles/motion.css";

export { MotionContext, useMotion } from "./lib/motion";
export * from "./primitives";
export * from "./patterns";
