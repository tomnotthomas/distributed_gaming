import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Client } from "./Client";
import { Host } from "./Host";
import { Swiff } from "./swiff/Swiff";
import "./swiff/swiff.css";
import "./swiff/crew.css";
import "./posthog";

// Three routes, one bundle. "/" is the product — the live wall, with Share your
// PC at "/share" (the renter app reads that path itself). "/host" is the
// gaming PC, and "/rtc" is the bare WebRTC handshake the streaming e2e suite
// drives, kept reachable because it is the only page that proves the transport.
const path = location.pathname.replace(/\/+$/, "");
const screen = path === "/host" ? <Host /> : path === "/rtc" ? <Client /> : <Swiff />;

createRoot(document.getElementById("root")!).render(<StrictMode>{screen}</StrictMode>);
