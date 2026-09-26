type Props<T extends string> = {
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
};

/**
 * One of a few. Native radios in a row: they come with arrow-key navigation and
 * a single tab stop, which a div-based segmented control has to reimplement.
 */
export function Segment<T extends string>({ name, options, value, onChange }: Props<T>) {
  return (
    <div className="seg glass" role="radiogroup">
      {options.map((opt) => (
        <label key={opt.value} className={opt.value === value ? "seg-opt seg-on" : "seg-opt"}>
          <input
            type="radio"
            name={name}
            checked={opt.value === value}
            onChange={() => onChange(opt.value)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}
