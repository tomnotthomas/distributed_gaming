import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DemoApp, RealApp } from "./App";
import { isDemo, isDemoScreen } from "./demo";
import { TrayWindow } from "./screens/Tray";
import "./host.css";

// main.cjs opens the app window as index.html, the tray glance as ?view=tray,
// and either one with ?demo=1 when launched with --demo. `screen` opens the
// demo on one of the design's screens.
const params = new URLSearchParams(location.search);
const screen = params.get("screen");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {params.get("view") === "tray" ? (
      <TrayWindow />
    ) : isDemo(location.search) ? (
      <DemoApp screen={isDemoScreen(screen) ? screen : "pc"} />
    ) : (
      <RealApp />
    )}
  </StrictMode>,
);
