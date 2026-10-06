// A13: the tray glance, for an owner away from the app. It shows a snapshot the
// main window sends, and hands its one action back to the main window.

import { useEffect, useState } from "react";
import { trayBridge } from "../bridge";
import { demoArt } from "../demo";
import type { Glance, TrayAction } from "../model";
import { ArtContext, localArt } from "../ui/art";
import type { GlyphName } from "../ui/Glyph";
import { Art, DemoTag, Figure } from "../ui/parts";
import { Pill } from "../ui/Pill";

const ICONS: Record<TrayAction, GlyphName> = {
  "stop-new": "block",
  "allow-new": "play",
  pause: "pause",
  resume: "play",
  retry: "refresh",
};

export function TrayGlance({
  glance,
  onAction,
}: {
  glance: Glance;
  onAction: (action: TrayAction | "open") => void;
}) {
  return (
    <div className="glance">
      <div className="ph1">
        <span className="wm">SWIFF</span>
        <span className="mono">
          {glance.live ? <span className="live" /> : null}
          {glance.status}
        </span>
      </div>
      {glance.demo ? (
        <div className="demo-row">
          <DemoTag />
        </div>
      ) : null}
      {glance.game ? (
        <div className="popart">
          <span className="popimg">
            <Art appid={glance.game.appid} position="55% 40%" />
          </span>
          <span className="mono">{glance.game.caption}</span>
        </div>
      ) : null}
      {glance.figure ? (
        <Figure size="sm" unit={glance.figure.label}>
          <span className="cur">€</span>
          {glance.figure.amount}
        </Figure>
      ) : null}
      {glance.action ? (
        <Pill icon={ICONS[glance.action.id]} onClick={() => onAction(glance.action!.id)}>
          {glance.action.label}
        </Pill>
      ) : null}
      <div className="pf mono">
        <button type="button" className="lnk" onClick={() => onAction("open")}>
          Open Lanterel
        </button>
        <span>{glance.foot}</span>
      </div>
    </div>
  );
}

/** The tray window: the glance the main window last sent, until it sends the next. */
export function TrayWindow() {
  const [glance, setGlance] = useState<Glance | null>(null);
  useEffect(() => trayBridge()?.onGlance(setGlance), []);
  return (
    <div className="hx tray">
      {glance ? (
        <ArtContext.Provider value={glance.demo ? demoArt : localArt}>
          <TrayGlance glance={glance} onAction={(action) => trayBridge()?.trayAction(action)} />
        </ArtContext.Provider>
      ) : (
        <p className="glance soft">Open Lanterel to go live.</p>
      )}
    </div>
  );
}

/** The demo's picture of the glance, as it sits under the tray on a desktop. */
export function TrayDesk({
  glance,
  onAction,
  clock,
}: {
  glance: Glance;
  onAction: (action: TrayAction | "open") => void;
  clock: string;
}) {
  return (
    <div className="desk">
      <div className="menubar mono">
        <span>{clock}</span>
        <span className="trayic" aria-hidden="true">
          ◉
        </span>
      </div>
      <div className="pop">
        <TrayGlance glance={glance} onAction={onAction} />
      </div>
    </div>
  );
}
