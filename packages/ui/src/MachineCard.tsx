import { Meter } from "./Meter";
import { Tag } from "./Tag";

type Props = {
  name: string;
  /** "··" while the ping is still being measured. */
  ping: number | string;
  owner: string;
  picture: number;
  response: number;
  /** "3 h left" when it is free, "until 21:30" when it is not. */
  left: string;
  leftTone?: "live" | "time";
  /** "Recommended", "Lowest latency" — why this one is worth picking. */
  reason?: string;
  selected?: boolean;
  /** The first free machine: wider and larger, so the default reads as default. */
  recommended?: boolean;
  /** GPU and CPU, as the native tooltip. */
  hardware?: string;
  onPick: () => void;
};

/** One machine you could play on. The two meters say how it will actually feel. */
export function MachineCard({
  name,
  ping,
  owner,
  picture,
  response,
  left,
  leftTone = "live",
  reason,
  selected,
  recommended,
  hardware,
  onPick,
}: Props) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={hardware}
      aria-pressed={selected}
      className={`machine glass${recommended ? " machine-rec" : ""}${selected ? " machine-on" : ""}`}
    >
      <span className="machine-head">
        <span className="machine-id">
          <span className="machine-name">
            {name} <span className="machine-dot">·</span> {ping}
            <span className="machine-unit"> ms</span>
          </span>
          <span className="machine-owner">{owner}</span>
        </span>
        <span className="machine-tags">
          {reason ? <Tag tone="accent">{reason}</Tag> : null}
          <Tag tone={leftTone}>{left}</Tag>
        </span>
      </span>
      <span className="machine-meters">
        <Meter label="Picture" value={picture} />
        <Meter label="Response" value={response} />
      </span>
    </button>
  );
}
