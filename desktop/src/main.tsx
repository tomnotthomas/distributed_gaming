import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShareScreen } from "./ShareScreen";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShareScreen />
  </StrictMode>,
);
