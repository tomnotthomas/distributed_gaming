import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DemoApp, RealApp } from "./App";
import { isDemo, isDemoScreen } from "./demo";
import { reportWindowErrors } from "./errorReports";
import { TrayWindow } from "./screens/Tray";
// The design's three faces, bundled: the window loads no remote content.
import "@fontsource/michroma/400.css";
import "@fontsource/outfit/200.css";
import "@fontsource/outfit/300.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./host.css";

// main.cjs opens the app window as index.html, the tray glance as ?view=tray,
// and either one with ?demo=1 when launched with --demo. `screen` opens the
// demo on one of the design's screens.
const params = new URLSearchParams(location.search);
reportWindowErrors();
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
