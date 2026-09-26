type Props = {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
};

/** A setting that saves as you flip it. Rung 3: a native checkbox, styled. */
export function Toggle({ label, hint, checked, onChange }: Props) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint ? <span className="toggle-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="toggle-box"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
