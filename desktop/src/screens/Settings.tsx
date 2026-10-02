// A12: where this PC connects to Swiff, and the key it signs in with.

import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { connectionReady } from "../model";
import { Notice } from "../ui/Notice";
import { Plate } from "../ui/parts";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

/** One underlined field: its label, and a hint the input is described by. */
function Field({ label, hint, children }: { label: string; hint: string; children: ReactElement }) {
  const id = useId();
  return (
    <div className="fld">
      <label className="mono" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": `${id}-hint` })}
      <small id={`${id}-hint`}>{hint}</small>
    </div>
  );
}

/** Live states the connection cannot change under: pause sharing first. Offline is not one: fixing it is why. */
const LOCKED = new Set(["starting", "waiting", "session", "ending"]);

export function Settings({ view, actions, go }: ScreenProps) {
  const { connection, live } = view;
  const [url, setUrl] = useState(connection.url);
  const [machineId, setMachineId] = useState(connection.machineId);
  const [machineKey, setMachineKey] = useState(connection.machineKey);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const locked = LOCKED.has(live.kind);
  const preview = useRef<HTMLVideoElement>(null);

  // The saved key arrives from main after the first render.
  const savedKey = connection.machineKey;
  useEffect(() => {
    setMachineKey((typed) => typed || savedKey);
  }, [savedKey]);

  useEffect(() => {
    if (preview.current) preview.current.srcObject = connection.preview;
  }, [connection.preview]);

  const form = { url, machineId, machineKey };
  const save = async () => {
    setSaving(true);
    setFailed(null);
    try {
      await actions.saveConnection(form);
      go("live");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "The settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Settings</p>
          <h1>Connection</h1>
          <p className="ln">Where this PC connects to Swiff, and the key it signs in with.</p>
          <form
            id="connection"
            className="form ctl"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked && connectionReady(form)) void save();
            }}
          >
            <Field label="Signaling server" hint="The address the renter opens. Paste it exactly as given.">
              <input
                value={url}
                disabled={locked}
                placeholder="hushed-otter-42.trycloudflare.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field label="Machine id" hint="The id the key was made for.">
              <input
                value={machineId}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setMachineId(e.target.value)}
              />
            </Field>
            <Field label="Machine key" hint="From npm run machine-key. Stored encrypted on this PC.">
              <input
                type="password"
                value={machineKey}
                disabled={locked}
                autoComplete="off"
                onChange={(e) => setMachineKey(e.target.value)}
              />
            </Field>
            {connection.notice ? <Notice>{connection.notice}</Notice> : null}
            {failed ? <Notice>{failed}</Notice> : null}
          </form>
        </div>
        <Plate caption={["Preview", connection.preview ? "Capturing" : "Idle"]}>
          <div className="stagebox">
            {connection.preview ? (
              <video ref={preview} autoPlay muted playsInline aria-label="This PC's screen, as shared" />
            ) : (
              <span className="mono">Not capturing</span>
            )}
          </div>
        </Plate>
      </section>
      <div className="sz one">
        <div className="acts">
          <Pill
            icon="arrow"
            type="submit"
            form="connection"
            disabled={locked || saving || !connectionReady(form)}
          >
            Save and start sharing
          </Pill>
          {locked ? <span className="soft">Pause sharing to change these.</span> : null}
        </div>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
