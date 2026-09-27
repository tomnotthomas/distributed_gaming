import { createContext, useContext } from "react";

/**
 * Whether media may play. Screens provide it from their own motion setting; the
 * gallery provides it from its switch. Components that would autoplay video
 * (Backdrop) read it, so one setting turns every trailer into a still.
 */
export const MotionContext = createContext(true);

export const useMotion = () => useContext(MotionContext);
