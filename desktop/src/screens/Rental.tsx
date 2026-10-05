// Rental mode: what Swiff OS needs from this PC, what the owner changes in the
// BIOS (Swiff cannot), and the steps that install it, start it once, remove it
// or confirm its key again, with the one confirmation at the PC the install
// needs: Swiff's key, enrolled as a MOK with a one-time code. The steps run
// for real (main.cjs, rental-exec.cjs) after one UAC prompt, and each that
// changes the disk or the firmware waits for the owner to hold its button.
// Going live in Swiff OS is still a preview.

import { useEffect, useRef, useState } from "react";
import type { PlanStep, RentalPlan, RentalRead } from "../../rental.cjs";
import type { RentalRun } from "../model";
import {
  BIOS_STEPS,
  choiceGone,
  chosenTarget,
  codeGroups,
  firmwareChecks,
  gb,
  MOK_REMOVE_SCREENS,
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
import { HoldPill, Pill } from "../ui/Pill";
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

const PLAN_TITLE: Record<RentalPlan["kind"], string> = {
  install: "Installing rental mode",
  uninstall: "Removing rental mode",
  unkey: "Removing Swiff's key",
  mok: "Confirming Swiff's key again",
  once: "Starting Swiff OS once",
  start: "Going live in rental mode",
  stop: "Back to Windows",
};

/** What the plan's one action says, for the plans this app runs. Going live stays a preview. */
const RUN_LABEL: Partial<Record<RentalPlan["kind"], string>> = {
  install: "Install rental mode",
  uninstall: "Remove rental mode",
  unkey: "Remove Swiff's key",
  mok: "Confirm the security key again",
  once: "Start Swiff OS once",
};

/** 9,663,676,416 of 8,589,934,592 bytes → "9.7 of 8.6 GB". */
const gbOf = (done: number, total: number) => `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`;

/** One step on the plan's ladder: past, running, waiting for the owner's yes, or still to come. */
function StepRow({
  step,
  n,
  run,
  commands,
  onConfirm,
}: {
  step: PlanStep;
  n: number;
  run: RentalRun;
  commands: boolean;
  onConfirm: (yes: boolean) => void;
}) {
  const state = run.steps[step.id];
  const rung = state === "done" ? "done" : state ? "now" : "next";
  const progress = run.progress?.id === step.id ? run.progress : null;
  return (
    <li className={state === "failed" ? `${rung} fail` : rung}>
      <span className="pd" />
      <b>{step.title}</b>
      <span className="mono">{state === "done" ? "Done" : String(n).padStart(2, "0")}</span>
      {state === "running" ? (
        <small aria-live="polite">
          {progress ? `${progress.what}: ${gbOf(progress.done, progress.total)}` : "Working"}
        </small>
      ) : null}
      {state === "failed" ? (
        <small className="rerr">{run.failed?.error || "It did not finish."}</small>
      ) : null}
      {state === "stopped" ? <small>Stopped here: this step did not run.</small> : null}
      {!state && step.confirm && run.status === "idle" ? <small>Asks you before it runs</small> : null}
      {state === "confirm" && run.waiting === step.id ? (
        <div className="rask" role="group" aria-label={`Run: ${step.title}`}>
          <p>{step.confirm}</p>
          <div className="acts">
            <HoldPill icon="arrow" onFire={() => onConfirm(true)} label={`Hold to run: ${step.title}`}>
              Hold to run this step
            </HoldPill>
            <button type="button" className="lnk" onClick={() => onConfirm(false)}>
              Stop here
            </button>
          </div>
        </div>
      ) : null}
      {commands ? <pre className="rcmd">{step.commands.join("\n")}</pre> : null}
    </li>
  );
}

/** How a run stands, under its steps, with what the owner can do next. */
function RunFoot({
  plan,
  run,
  onRun,
  onUndo,
}: {
  plan: RentalPlan;
  run: RentalRun;
  onRun: () => void;
  onUndo: () => void;
}) {
  const label = RUN_LABEL[plan.kind];
  const failedStep = plan.steps.find((s) => s.id === run.failed?.step)?.title;
  // An install, or its undo, that stopped part way can be undone from what it recorded.
  const undo =
    plan.kind === "install" ? (
      <div className="acts">
        <Pill icon="undo" onClick={onUndo}>
          Undo what was done
        </Pill>
      </div>
    ) : null;
  if (!label)
    return (
      <Notice icon="lock">
        A preview: going live in Swiff OS comes in a later Swiff Host update. Nothing here runs.
      </Notice>
    );
  switch (run.status) {
    case "idle":
      return (
        <>
          <Notice icon="lock">
            Windows asks once for administrator rights. Before each step that changes the disk or the
            firmware, Swiff Host stops and runs it only while you hold its button.
          </Notice>
          <div className="acts">
            <Pill icon="arrow" onClick={onRun}>
              {label}
            </Pill>
          </div>
        </>
      );
    case "starting":
      return (
        <Notice icon="clock">Waiting for Windows: allow Swiff Host to make changes in its prompt.</Notice>
      );
    case "running":
      return run.waiting ? null : (
        <Notice icon="clock">Working. Keep Swiff Host open until the steps are done.</Notice>
      );
    case "failed":
      return (
        <>
          <Notice icon="warning">
            {failedStep
              ? `${failedStep} did not finish, for the reason under it. Nothing after it ran.`
              : `Nothing ran: ${run.failed?.error}`}
          </Notice>
          {failedStep ? undo : null}
        </>
      );
    case "stopped":
      return (
        <>
          <Notice icon="info">
            Stopped. The steps marked done stay done: undo them, or review the install again later.
          </Notice>
          {undo}
        </>
      );
    default:
      return (
        <Notice icon="check">
          {plan.steps.some((s) => s.ops.some((o) => o.op === "restart"))
            ? "Done. The PC restarts in a few seconds."
            : "Done."}
        </Notice>
      );
  }
}

/** The steps of a plan, in order, as they run, with the exact commands under each when asked. */
function Plan({
  plan,
  run,
  keyEnrolled,
  actions,
}: {
  plan: RentalPlan;
  run: RentalRun;
  /** The install asked the PC to trust Swiff's key: there may be a key to remove. */
  keyEnrolled: boolean;
  actions: ScreenProps["actions"];
}) {
  const [commands, setCommands] = useState(false);
  const busy = run.status === "starting" || run.status === "running";
  // The plan opens under the fold: bring it up, so the button visibly did something.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    box.current?.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [plan]);
  return (
    <div className="sz one" ref={box}>
      <Zone
        title={RUN_LABEL[plan.kind] ? PLAN_TITLE[plan.kind] : `Preview: ${PLAN_TITLE[plan.kind]}`}
        action={
          <span className="rpa">
            {/* The key's removal needs Swiff OS's boot partition, which the uninstall deletes. */}
            {plan.kind === "uninstall" && run.status === "idle" && keyEnrolled ? (
              <button type="button" className="lnk" onClick={() => actions.previewRental("unkey")}>
                Remove Swiff's key first
              </button>
            ) : null}
            <button type="button" className="lnk" onClick={() => setCommands((on) => !on)}>
              {commands ? "Hide the commands" : "Show the commands"}
            </button>
            {busy ? null : (
              <button type="button" className="lnk" onClick={actions.closeRentalPreview}>
                Close
              </button>
            )}
          </span>
        }
      >
        <ol className="ladder rplan">
          {plan.steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              n={i + 1}
              run={run}
              commands={commands}
              onConfirm={actions.confirmRentalStep}
            />
          ))}
        </ol>
        <RunFoot
          plan={plan}
          run={run}
          onRun={actions.runRental}
          onUndo={() => actions.previewRental("uninstall")}
        />
      </Zone>
      {/* The code is for the restart at the end: once a run stopped short of it, there is none. */}
      {plan.mok && run.status !== "failed" && run.status !== "stopped" ? (
        <MokGuide code={plan.mok.code} remove={plan.kind === "unkey"} />
      ) : null}
    </div>
  );
}

/**
 * The install's one confirmation at the PC: after its restart, shim's blue
 * MokManager screen asks the owner to enrol Swiff's key with the code shown
 * here. The code stays on this screen, large, for reading off at the PC.
 */
function MokGuide({ code, remove = false }: { code: string; remove?: boolean }) {
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
      title={
        remove ? "After the restart: confirm the key's removal" : "After the restart: confirm Swiff's key"
      }
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
            {remove
              ? "The PC restarts once to a blue screen. Confirm there, at the PC's own keyboard, that it stops trusting Swiff's key. Type the code with the number keys, without the space."
              : "The PC restarts once to a blue screen. Confirm Swiff's key there, at the PC's own keyboard, so Swiff OS can start under Secure Boot. Type the code with the number keys, without the space."}
          </p>
        </div>
        <ol className="ladder rplan rmoks">
          {(remove ? MOK_REMOVE_SCREENS : MOK_SCREENS).map((s, i) => (
            <li key={i} className="next">
              <span className="pd" />
              <b>{s.act}</b>
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              <small className="mono">{s.screen}</small>
            </li>
          ))}
        </ol>
      </div>
      {remove ? (
        <Notice icon="refresh">
          Missed the blue screen? It waits 10 seconds, then Swiff OS starts as usual and the key stays
          trusted. Restart to get back to Windows, and choose Remove Swiff's key again.
        </Notice>
      ) : (
        <Notice icon="refresh">
          Missed the blue screen? It waits 10 seconds, then the PC shows a security error and falls back to
          Windows, with the key not enrolled. Come back to Rental mode and choose Confirm the security key
          again: the PC restarts once more, with a new code.
        </Notice>
      )}
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
          {read.facts.install && !read.installed ? (
            <>
              <p className="soft">
                The install stopped before it finished. Continue it into the room it already made, or undo
                each step it got to: either way Windows and your files stay as they are.
              </p>
              <div className="acts">
                <Pill
                  icon="arrow"
                  onClick={() => actions.previewRental("install")}
                  disabled={status.bios.length > 0 || status.fixes.length > 0}
                >
                  Continue the install
                </Pill>
                <button type="button" className="lnk" onClick={() => actions.previewRental("uninstall")}>
                  Undo what was done
                </button>
              </div>
            </>
          ) : read.installed ? (
            <>
              <p className="soft">
                Start Swiff OS once to try it. Whatever happens there, the PC starts Windows on its next
                restart. Going live will restart into Swiff OS and keep it first while you share.
              </p>
              <div className="acts">
                <Pill icon="play" onClick={() => actions.previewRental("once")}>
                  Start Swiff OS once
                </Pill>
                <button type="button" className="lnk" onClick={() => actions.previewRental("start")}>
                  Preview going live
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
                <button type="button" className="lnk" onClick={() => actions.previewRental("unkey")}>
                  Remove Swiff's key
                </button>
                <button type="button" className="lnk" onClick={() => actions.previewRental("uninstall")}>
                  Remove rental mode
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
      {preview ? (
        <Plan
          plan={preview}
          run={view.rental.run}
          keyEnrolled={read.facts.install?.mok === true}
          actions={actions}
        />
      ) : null}
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
