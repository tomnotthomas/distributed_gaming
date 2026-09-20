import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Client } from "./Client";
import { Host } from "./Host";

// Two routes, one bundle: "/host" is the gaming PC, everything else is the
// renter. Same origin means the signaling URL is just window.location.
const isHost = location.pathname.replace(/\/+$/, "") === "/host";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isHost ? <Host /> : <Client />}</StrictMode>,
);
