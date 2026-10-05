// A12: where this PC connects to Swiff, the key it signs in with, and the name players see.
// The signaling server, the screen preview and going live from here belong to
// sharing this Windows desktop, a development path only (devShare.ts).

import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { WINDOWS_SHARE } from "../devShare";
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
  const [name, setName] = useState(connection.name);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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

  const form = { url, machineId, machineKey, name };
  const save = async () => {
    setSaving(true);
    setFailed(null);
    setSaved(false);
    try {
      await actions.saveConnection(form);
      if (WINDOWS_SHARE) go("live");
      else setSaved(true);
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
          <p className="ln">How this PC connects to Swiff.</p>
          <form
            id="connection"
            className="form ctl"
            onSubmit={(event) => {
              event.preventDefault();
              if (!locked && (!WINDOWS_SHARE || connectionReady(form))) void save();
            }}
          >
            {WINDOWS_SHARE ? (
              <Field label="Signaling server" hint="Paste the address exactly as you got it.">
                <input
                  value={url}
                  disabled={locked}
                  placeholder="hushed-otter-42.trycloudflare.com"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Machine ID" hint="The ID that goes with your key.">
              <input
                value={machineId}
                disabled={locked}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setMachineId(e.target.value)}
              />
            </Field>
            <Field label="Machine key" hint="Stored encrypted on this PC.">
              <input
                type="password"
                value={machineKey}
                disabled={locked}
                autoComplete="off"
                onChange={(e) => setMachineKey(e.target.value)}
              />
            </Field>
            <Field label="Name" hint="The name players see. Leave it empty to use the machine ID.">
              <input
                value={name}
                disabled={locked}
                maxLength={64}
                placeholder={machineId.trim() || "Nova-01"}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {connection.notice ? <Notice>{connection.notice}</Notice> : null}
            {failed ? <Notice>{failed}</Notice> : null}
          </form>
        </div>
        {WINDOWS_SHARE ? (
          <Plate caption={["Preview", connection.preview ? "Capturing" : "Idle"]}>
            <div className="stagebox">
              {connection.preview ? (
                <video ref={preview} autoPlay muted playsInline aria-label="This PC's screen, as shared" />
              ) : (
                <span className="mono">Not capturing</span>
              )}
            </div>
          </Plate>
        ) : (
          <Plate caption={["This PC", "Name players see"]}>
            <div className="stagebox">
              <span className="mono">{name.trim() || machineId.trim() || "Not named yet"}</span>
            </div>
          </Plate>
        )}
      </section>
      <div className="sz one">
        <div className="acts">
          <Pill
            icon="arrow"
            type="submit"
            form="connection"
            disabled={locked || saving || (WINDOWS_SHARE && !connectionReady(form))}
          >
            {WINDOWS_SHARE ? "Save and go live" : "Save"}
          </Pill>
          {locked ? <span className="soft">Pause to change these.</span> : null}
          {saved ? (
            <span className="soft" role="status">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
