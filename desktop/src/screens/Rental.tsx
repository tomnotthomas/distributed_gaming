// Rental mode: what Swiff OS needs from this PC, what the owner changes in the
// BIOS (Swiff cannot), and the steps that install it and switch to it. The
// steps show as a preview: nothing on the PC is changed from this screen yet.

import { useState } from "react";
import type { RentalPlan, RentalRead } from "../../rental.cjs";
import {
  chosenTarget,
  firmwareChecks,
  gb,
  pcChecks,
  rentalStatus,
  targetLine,
  type RentalCheck,
} from "../rental";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Kv, Plate, Zone } from "../ui/parts";
import { Notice } from "../ui/Notice";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

/** One check as a ruled row, with a mark where it is not ready yet. */
function CheckRow({ check }: { check: RentalCheck }) {
  const mark = check.state === "bios" || check.state === "blocked";
  return (
    <Kv label={check.label}>
      <span className={mark ? "rck warn" : "rck"}>
        {mark ? <Glyph name="warning" size={14} /> : null}
        {check.value}
      </span>
    </Kv>
  );
}

const PREVIEW_TITLE: Record<RentalPlan["kind"], string> = {
  install: "Installing rental mode",
  start: "Going live in rental mode",
  stop: "Back to Windows",
};

/** The steps of a plan, in order, with the exact commands under each when asked. */
function Preview({ plan, onClose }: { plan: RentalPlan; onClose: () => void }) {
  const [commands, setCommands] = useState(false);
  return (
    <div className="sz one">
      <Zone
        title={`Preview: ${PREVIEW_TITLE[plan.kind]}`}
        action={
          <span className="rpa">
            <button type="button" className="lnk" onClick={() => setCommands((on) => !on)}>
              {commands ? "Hide the commands" : "Show the commands"}
            </button>
            <button type="button" className="lnk" onClick={onClose}>
              Close
            </button>
          </span>
        }
      >
        <ol className="ladder rplan">
          {plan.steps.map((step, i) => (
            <li key={step.id} className="next">
              <span className="pd" />
              <b>{step.title}</b>
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              {commands ? <pre className="rcmd">{step.commands.join("\n")}</pre> : null}
            </li>
          ))}
        </ol>
        <Notice icon="lock">
          A preview: nothing on this PC has been changed. Rental mode is installed for the first time with
          Swiff beside you.
        </Notice>
      </Zone>
    </div>
  );
}

/** Where Swiff OS goes, when there is more than one place: the owner picks, never the size. */
function TargetPicker({
  read,
  value,
  onChange,
}: {
  read: RentalRead;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const chosen = chosenTarget(read, value);
  return (
    <div className="until rtg" role="radiogroup" aria-label="Space for Swiff OS">
      {read.targets.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === chosen?.id}
          className="ut"
          onClick={() => onChange(t.id)}
        >
          <b>{t.kind === "shrink" ? `${t.letter}:` : `Disk ${t.disk}`}</b>
          <span>{t.kind === "shrink" ? "shrinks" : "free space"}</span>
        </button>
      ))}
    </div>
  );
}

export function RentalSetupScreen({ view, actions }: ScreenProps) {
  const { reading, read, target, preview } = view.rental;

  if (!read) {
    return (
      <main className="step">
        <section className="hz">
          <div className="cp">
            <p className="mono ctx">Rental mode</p>
            <h1>{reading ? "Checking this PC" : "Rental mode needs Windows"}</h1>
            <p className="ln">
              {reading
                ? "What Swiff OS needs: UEFI, Secure Boot, a TPM, an IOMMU, 24 GB of space and a readable games drive."
                : "Swiff reads what rental mode needs from Windows, and this PC could not be read."}
            </p>
          </div>
          <Plate caption={["Rental mode", reading ? "Reading" : "Not read"]}>
            <Dial progress={0} big="…" small="ready" />
          </Plate>
        </section>
        <i className="ruler" aria-hidden="true" />
      </main>
    );
  }

  const status = rentalStatus(read, target);
  const where = chosenTarget(read, target);

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Rental mode</p>
          <h1>{status.title}</h1>
          <p className="ln">{status.line}</p>
          {status.bios.length || status.fixes.length ? (
            <ol className="legend rfix">
              {[...status.bios, ...status.fixes].map((fix, i) => (
                <li key={fix} className={i === 0 ? "lg st-now" : "lg st-next"}>
                  <span className="dotst" />
                  <span>{fix}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ln soft">
              While you share, this PC runs Swiff OS: a locked system where nobody at the PC can reach the
              player&rsquo;s Steam account. To use the PC yourself, stop sharing from your phone; it comes
              back to Windows once no player is on it.
            </p>
          )}
          {status.bios.length || status.fixes.length ? (
            <div className="acts">
              <Pill icon="refresh" onClick={actions.checkRental} disabled={reading}>
                {reading ? "Checking" : "Check again"}
              </Pill>
            </div>
          ) : null}
        </div>
        <Plate
          caption={[
            "Rental mode",
            reading ? "Reading" : read.installed ? "Installed" : status.canInstall ? "Ready" : "Not ready",
          ]}
        >
          <Dial progress={status.ready / status.of} big={`${status.ready} of ${status.of}`} small="ready" />
        </Plate>
      </section>

      <div className="sz three">
        <Zone title="Firmware">
          {firmwareChecks(read).map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </Zone>
        <Zone title="This PC">
          {pcChecks(read, target).map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </Zone>
        <Zone title={read.installed ? "Switch" : "Install"}>
          {read.installed ? (
            <>
              <p className="soft">
                Going live restarts this PC into Swiff OS, first in its boot order while you share. Stopping
                puts Windows first again.
              </p>
              <div className="acts">
                <Pill icon="play" onClick={() => actions.previewRental("start")}>
                  Go live
                </Pill>
                <button type="button" className="lnk" onClick={() => actions.previewRental("stop")}>
                  Back to Windows
                </button>
              </div>
            </>
          ) : (
            <>
              {read.targets.length > 1 ? (
                <TargetPicker read={read} value={target} onChange={actions.chooseRentalTarget} />
              ) : null}
              <p className="soft">
                {where
                  ? `Swiff OS takes ${targetLine(where, read.need)}, a fixed size. Windows and your files stay as they are.`
                  : `Swiff OS needs ${gb(read.need)} of its own.`}
              </p>
              <div className="acts">
                <Pill
                  icon="arrow"
                  onClick={() => actions.previewRental("install")}
                  disabled={!status.canInstall}
                >
                  Review the install
                </Pill>
              </div>
            </>
          )}
        </Zone>
      </div>
      {preview ? <Preview plan={preview} onClose={actions.closeRentalPreview} /> : null}
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
