// The hairline instruments of the Paper Band look: tick rings, the wall's two
// hero dials, the game page's crosshair dial and Ignition's progress dial. They
// are drawn in SVG from circles and straight lines only, in currentColor, so
// each screen decides whether they print in ink or in paper.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const LIME = "#d4f53c";

/** Under reduced motion nothing moves on its own; read once per mount. */
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** Point on a circle, clockwise from twelve o'clock. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** One path for a ring of ticks running inward from `r`, every `step` degrees. */
function tickPath(cx: number, cy: number, r: number, len: number, step: number): string {
  let d = "";
  for (let deg = 0; deg < 360; deg += step) {
    const [x1, y1] = polar(cx, cy, r, deg);
    const [x2, y2] = polar(cx, cy, r - len, deg);
    d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}

type Ring = { cx: number; cy: number; r: number; minor: number; major: number; step: number; every: number };

/** A tick ring: short minor ticks, longer major ones every `every` degrees. */
function Ticks({
  cx,
  cy,
  r,
  minor,
  major,
  step,
  every,
  minorOpacity = 0.55,
  majorOpacity = 0.9,
}: Ring & {
  minorOpacity?: number;
  majorOpacity?: number;
}) {
  return (
    <>
      <path d={tickPath(cx, cy, r, minor, step)} stroke="currentColor" opacity={minorOpacity} />
      <path d={tickPath(cx, cy, r, major, every)} stroke="currentColor" opacity={majorOpacity} />
    </>
  );
}

/** A cross through (cx, cy) that stops `gap` short of the centre on every arm. */
function Cross({
  cx,
  cy,
  gap,
  w,
  h,
  top = 0,
}: {
  cx: number;
  cy: number;
  gap: number;
  w: number;
  h: number;
  top?: number;
}) {
  return (
    <path
      d={`M0 ${cy}H${cx - gap}M${cx + gap} ${cy}H${w}M${cx} ${top}V${cy - gap}M${cx} ${cy + gap}V${h}`}
      stroke="currentColor"
      opacity={0.22}
    />
  );
}

/**
 * Spin the Resume rings while their button is pointed at or focused. The speed
 * eases up to about 30° a second and coasts back to rest, so nothing jumps.
 * Returns props for the button and refs for the two ring groups.
 */
export function useSpin() {
  const host = useRef<HTMLDivElement>(null);
  const inner = useRef<SVGGElement>(null);
  const outer = useRef<SVGGElement>(null);
  const hot = useRef(false);
  const raf = useRef(0);
  const speed = useRef(0);
  const angle = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const set = (on: boolean) => {
    hot.current = on;
    if (raf.current || prefersReducedMotion()) return;
    let last = performance.now();
    // The angle carries over between hovers: the rings rest where they stopped.
    const tick = (t: number) => {
      const dt = Math.min(50, t - last) / 1000;
      last = t;
      speed.current += ((hot.current ? 1 : 0) - speed.current) * Math.min(1, dt * 2.6);
      angle.current += speed.current * dt * 30;
      inner.current?.setAttribute("transform", `rotate(${angle.current.toFixed(2)} 200 240)`);
      outer.current?.setAttribute("transform", `rotate(${(-0.6 * angle.current).toFixed(2)} 200 240)`);
      host.current?.classList.toggle("spinning", speed.current > 0.05);
      raf.current = hot.current || speed.current > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  };

  const trigger = {
    onPointerEnter: () => set(true),
    onPointerLeave: () => set(false),
    onFocus: () => set(true),
    onBlur: () => set(false),
  };
  return { host, inner, outer, trigger };
}

/** The signed-in instrument: a 60-tick ring around Resume, with an orbit that shows while it spins. */
export function ResumeDial({ spin, children }: { spin: ReturnType<typeof useSpin>; children: ReactNode }) {
  return (
    <div className="dial-box" ref={spin.host}>
      <svg viewBox="0 0 400 480" aria-hidden="true" fill="none">
        <Cross cx={200} cy={240} gap={96} w={400} h={440} top={40} />
        <g ref={spin.inner}>
          <circle cx={200} cy={240} r={140} stroke="currentColor" opacity={0.6} />
          <Ticks cx={200} cy={240} r={140} minor={8} major={16} step={6} every={45} />
        </g>
        <g ref={spin.outer}>
          <circle cx={200} cy={240} r={184} stroke="currentColor" opacity={0.2} />
          <circle
            className="dial-orbit"
            cx={200}
            cy={240}
            r={184}
            stroke="currentColor"
            strokeWidth={1.6}
            strokeDasharray="104 1156.1"
            transform="rotate(-120 200 240)"
          />
        </g>
      </svg>
      {children}
    </div>
  );
}

/** The signed-out instrument: how many machines are free, inside the same ring. */
export function CountDial({ count }: { count: number }) {
  return (
    <div className="dial-box">
      <svg viewBox="0 0 400 480" aria-hidden="true" fill="none">
        <Cross cx={200} cy={240} gap={108} w={400} h={440} top={40} />
        <circle cx={200} cy={240} r={108} stroke="currentColor" opacity={0.9} />
        <Ticks cx={200} cy={240} r={150} minor={8} major={16} step={6} every={45} />
        <circle cx={200} cy={240} r={184} stroke="currentColor" opacity={0.2} />
      </svg>
      <div className="dial-count">
        <b>{count}</b>
        <span className="mono">
          {count === 1 ? "machine" : "machines"} free
          <br />
          near you
        </span>
      </div>
    </div>
  );
}

const CLOCK_LABELS = [
  { label: "00", hour: 0 },
  { label: "06", hour: 6 },
  { label: "12", hour: 12 },
  { label: "18", hour: 18 },
];

/**
 * Share your PC's instrument: a 24-hour clock with midnight at twelve, a tick
 * every quarter hour, and the evening away drawn as an ink arc ending in lime.
 */
export function AwayDial({ from, hours, children }: { from: number; hours: number; children: ReactNode }) {
  const start = from * 15;
  const end = (from + hours) * 15;
  const [x0, y0] = polar(200, 240, 166, start);
  const [x1, y1] = polar(200, 240, 166, end);
  return (
    <div className="dial-box">
      <svg viewBox="0 0 400 480" aria-hidden="true" fill="none">
        <Cross cx={200} cy={240} gap={124} w={400} h={440} top={40} />
        <circle cx={200} cy={240} r={184} stroke="currentColor" opacity={0.2} />
        <circle cx={200} cy={240} r={150} stroke="currentColor" opacity={0.6} />
        <Ticks
          cx={200}
          cy={240}
          r={150}
          minor={5}
          major={10}
          step={3.75}
          every={15}
          minorOpacity={0.4}
          majorOpacity={0.7}
        />
        <path d={tickPath(200, 240, 150, 18, 90)} stroke="currentColor" opacity={0.9} />
        {CLOCK_LABELS.map(({ label, hour }) => {
          const [x, y] = polar(200, 244, 116, hour * 15);
          return (
            <text key={label} x={x.toFixed(1)} y={y.toFixed(1)} textAnchor="middle" className="dial-n">
              {label}
            </text>
          );
        })}
        <path
          className="away-arc"
          d={`M${x0.toFixed(1)} ${y0.toFixed(1)}A166 166 0 ${end - start > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`}
          stroke="currentColor"
          strokeWidth={2.4}
        />
        <circle cx={x1.toFixed(1)} cy={y1.toFixed(1)} r={5} fill={LIME} stroke="currentColor" />
      </svg>
      {children}
    </div>
  );
}

/** The game page's lens: a clear circle of key art inside a 120-tick ring, on a crosshair. */
export function LensDial() {
  return (
    <svg className="lens-dial" viewBox="-300 -300 600 600" aria-hidden="true" fill="none">
      <circle r={210} stroke="currentColor" opacity={0.6} />
      <Ticks cx={0} cy={0} r={238} minor={8} major={18} step={3} every={30} minorOpacity={0.5} />
      <circle r={290} stroke="currentColor" opacity={0.2} />
      <circle r={4} fill="currentColor" />
      <circle cx={-210} r={4} fill="currentColor" />
      <circle cx={210} r={4} fill="currentColor" />
    </svg>
  );
}

/** A 0 to 100 reading eased toward `target`, or set at once under reduced motion. */
export function useEased(target: number): number {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion()) {
      current.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(64, t - last) / 1000;
      last = t;
      const gap = target - current.current;
      current.current = Math.abs(gap) < 0.05 ? target : current.current + gap * Math.min(1, dt * 5);
      setShown(current.current);
      if (current.current !== target) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

const IGNITION_LABELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

/** Ignition's dial: a 100-tick scale, the progress arc with its lime head, and a needle. */
export function IgnitionDial({ pct }: { pct: number }) {
  const angle = pct * 3.6;
  const [hx, hy] = polar(0, 0, 256, angle);
  return (
    <svg className="ig-dial" viewBox="-360 -280 720 560" aria-hidden="true" fill="none">
      <path d="M-360 0H360M0 -270V270" stroke="currentColor" opacity={0.14} />
      <circle r={240} stroke="currentColor" opacity={0.9} />
      <path d={tickPath(0, 0, 232, 8, 3.6)} stroke="currentColor" opacity={0.55} />
      <path d={tickPath(0, 0, 232, 18, 36)} stroke="currentColor" strokeWidth={1.2} />
      {IGNITION_LABELS.map((n) => {
        const [x, y] = polar(0, 4, 192, n * 3.6);
        return (
          <text key={n} x={x.toFixed(1)} y={y.toFixed(1)} textAnchor="middle" className="ig-dial-n">
            {n}
          </text>
        );
      })}
      <circle
        r={256}
        stroke="currentColor"
        strokeWidth={2}
        pathLength={100}
        strokeDasharray="100 100"
        strokeDashoffset={(100 - pct).toFixed(2)}
        transform="rotate(-90)"
      />
      <circle cx={hx.toFixed(1)} cy={hy.toFixed(1)} r={5} fill={LIME} stroke="currentColor" />
      <circle r={120} stroke="currentColor" opacity={0.35} />
      <circle r={60} stroke="currentColor" opacity={0.35} strokeDasharray="2 5" />
      <g transform={`rotate(${angle.toFixed(2)})`}>
        <line y2={-170} stroke="currentColor" strokeWidth={1.4} />
        <circle cy={-170} r={4} fill={LIME} />
      </g>
      <circle r={6} stroke="currentColor" />
    </svg>
  );
}

/** The time-free mark on a tile: an ink arc out of eight hours, in a hairline ring. */
export function TimeMark({ minutes }: { minutes: number }) {
  const share = Math.max(0, Math.min(100, (minutes / 480) * 100));
  return <i className="time-mark" style={{ "--h": share.toFixed(0) } as CSSProperties} aria-hidden="true" />;
}
