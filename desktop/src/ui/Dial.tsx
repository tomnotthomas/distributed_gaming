// The instrument on every plate: a hairline tick ring with one arc on it and a
// lime head where the arc ends. Drawn in currentColor from circles and straight
// lines only, so the plate decides the ink.

import type { ReactNode } from "react";

const C = 150;

/** A point on the dial, clockwise from twelve o'clock. */
function polar(r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
}

function ticks(every: number, skip: number, len: number): string {
  let d = "";
  for (let deg = 0; deg < 360; deg += every) {
    if (skip && deg % skip === 0) continue;
    const [x1, y1] = polar(122, deg);
    const [x2, y2] = polar(122 - len, deg);
    d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}

const MINOR = ticks(6, 30, 8);
const MAJOR = ticks(30, 0, 14);
const CROSS = "M0 150H52M248 150H300M150 0V52M150 248V300";

type Props = {
  /** The figure in the middle, and its caption under it. */
  big: ReactNode;
  small: ReactNode;
  /** How far round the arc runs from twelve, 0 to 1. Null draws no arc. */
  progress?: number | null;
  /** A span of the 24-hour clock, in hours from midnight: tonight's sharing window. */
  hours?: { from: number; to: number } | null;
  /** The tick ring turns slowly: a session is running. Still under reduced motion. */
  live?: boolean;
  /** Nothing can happen: the ring is faint and carries no arc. */
  off?: boolean;
  /** A mark at twelve for a broken connection. */
  cut?: boolean;
};

export function Dial({ big, small, progress = null, hours = null, live, off, cut }: Props) {
  const share = progress === null ? null : Math.max(0, Math.min(1, progress));
  const head = (() => {
    if (hours) return polar(132, (hours.to % 24) * 15);
    if (share !== null) return polar(132, share * 360);
    return null;
  })();
  const span = hours ? (hours.to - hours.from + 24) % 24 || 24 : 0;

  return (
    <div className={["dial", off && "off"].filter(Boolean).join(" ")}>
      <svg className="dsvg" viewBox="0 0 300 300" aria-hidden="true" fill="none">
        <path d={CROSS} stroke="currentColor" opacity={0.25} />
        <circle cx={C} cy={C} r={146} stroke="currentColor" opacity={0.18} />
        <g className={["tring", live && "live"].filter(Boolean).join(" ")}>
          <circle cx={C} cy={C} r={122} stroke="currentColor" opacity={0.55} />
          <path d={MINOR} stroke="currentColor" opacity={0.45} />
          <path d={MAJOR} stroke="currentColor" opacity={0.85} />
        </g>
        {hours ? (
          <>
            {["00", "06", "12", "18"].map((label, i) => {
              const [x, y] = polar(92, i * 90);
              return (
                <text key={label} x={x} y={y + 4} textAnchor="middle" className="dl">
                  {label}
                </text>
              );
            })}
            <circle
              className="arc"
              cx={C}
              cy={C}
              r={132}
              stroke="currentColor"
              strokeWidth={5}
              pathLength={24}
              strokeDasharray={`${span} 24`}
              transform={`rotate(${hours.from * 15 - 90} ${C} ${C})`}
            />
          </>
        ) : null}
        {share !== null && !off ? (
          <circle
            className="arc"
            cx={C}
            cy={C}
            r={132}
            stroke="currentColor"
            strokeWidth={2.2}
            pathLength={100}
            strokeDasharray="100 100"
            strokeDashoffset={(100 - share * 100).toFixed(2)}
            transform={`rotate(-90 ${C} ${C})`}
          />
        ) : null}
        {head && !off ? <circle cx={head[0]} cy={head[1]} r={4.5} fill="#d4f53c" stroke="#9cb52a" /> : null}
        {cut ? <path d="M143 13l14 14M157 13l-14 14" stroke="currentColor" strokeWidth={1.4} /> : null}
        <circle cx={C} cy={C} r={96} stroke="currentColor" opacity={0.3} />
      </svg>
      <div className="dc">
        <b className={typeof big === "string" && big.length > 6 ? "long" : undefined}>{big}</b>
        <span className="mono">{small}</span>
      </div>
    </div>
  );
}

/** Hours from midnight, with minutes as a fraction: 21:30 → 21.5. */
export const hourOf = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};
