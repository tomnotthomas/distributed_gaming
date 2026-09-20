import type { InputHTMLAttributes } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string };

/**
 * A labelled text input. The Electron host needs one the web app does not:
 * it is not served from the signaling server, so the address has to be typed
 * in rather than read off `location`.
 */
export function Field({ label, hint, id, ...rest }: Props) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input {...rest} id={id} className="input" />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
