// Rental mode: what Swiff OS needs from this PC, what the owner changes in the
// BIOS (Swiff cannot), and the steps that install it and switch to it, with
// the one confirmation at the PC the install needs: Swiff's key, enrolled as a
// MOK with a one-time code. The steps show as a preview: nothing on the PC is
// changed from this screen yet.

import { useEffect, useRef, useState } from "react";
import type { RentalPlan, RentalRead } from "../../rental.cjs";
import {
  BIOS_STEPS,
  choiceGone,
  chosenTarget,
  codeGroups,
  firmwareChecks,
  gb,
  MOK_SCREENS,
  pcChecks,
  rentalStatus,
  targetLine,
  type RentalCheck,
} from "../rental";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Figure, Kv, Plate, Zone } from "../ui/parts";
import { Notice } from "../ui/Notice";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

/** One check as a ruled row, with a mark where it is not ready yet, and its detail under it. */
function CheckRow({ check }: { check: RentalCheck }) {
  const mark = check.state === "bios" || check.state === "blocked";
  return (
    <>
      <Kv label={check.label}>
        <span className={mark ? "rck warn" : "rck"}>
          {mark ? <Glyph name="warning" size={14} /> : null}
          {check.value}
        </span>
      </Kv>
      {check.detail ? <p className="rck-note">{check.detail}</p> : null}
    </>
  );
}

const PREVIEW_TITLE: Record<RentalPlan["kind"], string> = {
  install: "Installing rental mode",
  mok: "Confirming Swiff's key again",
  start: "Going live in rental mode",
  stop: "Back to Windows",
};

/** The steps of a plan, in order, with the exact commands under each when asked. */
function Preview({ plan, onClose }: { plan: RentalPlan; onClose: () => void }) {
  const [commands, setCommands] = useState(false);
  // The preview opens under the fold: bring it up, so the button visibly did something.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    box.current?.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [plan]);
  return (
    <div className="sz one" ref={box}>
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
          A preview: nothing on this PC has been changed. Installing for real comes in a later Swiff Host
          update.
        </Notice>
      </Zone>
      {plan.mok ? <MokGuide code={plan.mok.code} /> : null}
    </div>
  );
}

/**
 * The install's one confirmation at the PC: after its restart, shim's blue
 * MokManager screen asks the owner to enrol Swiff's key with the code shown
 * here. The code stays on this screen, large, for reading off at the PC.
 */
function MokGuide({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  // "Copied" stands for a moment, then the link offers to copy again.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <Zone
      title="After the restart: confirm Swiff's key"
      action={
        navigator.clipboard ? (
          <button type="button" className="lnk" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy the code"}
          </button>
        ) : null
      }
    >
      <div className="rmok">
        <div className="rcode">
          <Figure unit="one-time code">
            <span className="rcv">{codeGroups(code)}</span>
          </Figure>
          <p className="soft">
            The PC restarts once to a blue screen. Confirm Swiff's key there, at the PC's own keyboard, so
            Swiff OS can start under Secure Boot. Type the code with the number keys, without the space.
          </p>
        </div>
        <ol className="ladder rplan rmoks">
          {MOK_SCREENS.map((s, i) => (
            <li key={i} className="next">
              <span className="pd" />
              <b>{s.act}</b>
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              <small className="mono">{s.screen}</small>
            </li>
          ))}
        </ol>
      </div>
      <Notice icon="refresh">
        Missed the blue screen? It waits 10 seconds, then the PC shows a security error and falls back to
        Windows, with the key not enrolled. Come back to Rental mode and choose Confirm the security key
        again: the PC restarts once more, with a new code.
      </Notice>
    </Zone>
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
            <h1>{reading ? "Checking this PC" : "This PC was not read"}</h1>
            <p className="ln">
              {reading
                ? "What Swiff OS needs: UEFI, Secure Boot, a TPM, an IOMMU, 24 GB of space and a readable games drive."
                : "Swiff reads what rental mode needs from Windows, and the read did not finish. Check again."}
            </p>
            {reading ? null : (
              <div className="acts">
                <Pill icon="refresh" onClick={actions.checkRental}>
                  Check again
                </Pill>
              </div>
            )}
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
  const todo = status.bios.length ? status.bios : status.fixes;

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Rental mode</p>
          <h1>{status.title}</h1>
          <p className="ln">{status.line}</p>
          {todo.length ? (
            <ol className="legend rfix">
              {todo.map((fix, i) => (
                <li key={fix} className={i === 0 ? "lg st-now" : "lg st-next"}>
                  <span className="dotst" />
                  <span>{fix}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ln soft">
              To use the PC yourself, stop sharing from your phone. It returns to Windows once no player is on
              it.
            </p>
          )}
          {/* The headline counts BIOS changes: what else blocks rental mode is said apart from them. */}
          {status.bios.length
            ? status.fixes.map((fix) => (
                <Notice key={fix} icon="warning">
                  {fix}
                </Notice>
              ))
            : null}
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
                Going live will restart this PC into Swiff OS, first in its boot order while you share.
                Stopping puts Windows first again.
              </p>
              <div className="acts">
                <Pill icon="play" onClick={() => actions.previewRental("start")}>
                  Preview going live
                </Pill>
                <button type="button" className="lnk" onClick={() => actions.previewRental("stop")}>
                  Preview back to Windows
                </button>
              </div>
              {/* Whether the key is enrolled is not read yet (MokListRT): the owner says they missed it. */}
              <p className="soft ragain">
                Missed the blue screen after installing? Swiff OS cannot start until its key is confirmed.
              </p>
              <div className="acts">
                <button type="button" className="lnk" onClick={() => actions.previewRental("mok")}>
                  Confirm the security key again
                </button>
              </div>
            </>
          ) : (
            <>
              {read.targets.length > 1 || choiceGone(read, target) ? (
                <TargetPicker read={read} value={target} onChange={actions.chooseRentalTarget} />
              ) : null}
              <p className="soft">
                {where
                  ? `Swiff OS takes ${targetLine(where, read.need)}, a fixed size. Windows and your files stay as they are.`
                  : `Swiff OS needs ${gb(read.need)} of its own.`}{" "}
                Then the PC restarts once, for you to confirm Swiff's key at its screen with a code shown
                here.
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
      {read.installed ? null : (
        <div className="sz one">
          <Zone title="In the BIOS, if it asks">
            <ol className="legend">
              {BIOS_STEPS.map((step) => (
                <li key={step} className="lg st-next">
                  <span className="dotst" />
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </Zone>
        </div>
      )}
      {preview ? <Preview plan={preview} onClose={actions.closeRentalPreview} /> : null}
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
