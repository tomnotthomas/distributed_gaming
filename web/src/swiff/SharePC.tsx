import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Backdrop } from "@swiff/ui";
import { GAMES } from "./data";
import {
  AWAY_FROM,
  LIMITS,
  TIERS,
  awayWindow,
  estimate,
  euros,
  tier,
  withArticle,
  type TierId,
  type Week,
} from "./estimate";
import { Glyph } from "./Glyph";
import { AwayDial } from "./instruments";
import RELEASE from "./release.json";
import { gameArt, gameArtFallbacks } from "./steam";
import type { Swiff } from "./useSwiff";

/**
 * What hosts download, as the release step published it (release.json, from
 * `node desktop/checksums.cjs release`): the installer's name, SHA-256 and
 * address, and the Swiff OS image set's files with theirs.
 */
export type Release = {
  host: { file: string; sha256: string; bytes: number; url: string | null } | null;
  image: { version: string; files: { name: string; sha256: string }[] } | null;
};

/**
 * Where the host installer is downloaded from, or null while none is published:
 * CI's package-desktop job builds SwiffHost-<version>.exe but keeps it only as a
 * three-day workflow artifact. Until release.json names an address the button
 * says Coming soon and goes nowhere; with one, the button is the download link.
 */
export const HOST_DOWNLOAD_URL: string | null = (RELEASE as Release).host?.url ?? null;

/** The estimate's key art: the mockup's, in full colour. */
const ART = GAMES.find((g) => g.id === "er")!;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A euro amount with the sign set small, as everywhere on the page. */
function Eur({ n, decimals = 0 }: { n: number; decimals?: number }) {
  return (
    <>
      <span className="cur">€</span>
      {euros(n, decimals)}
    </>
  );
}

/**
 * Share your PC, the website half of hosting: what a PC could earn, how that
 * number was reached, and the one download. Reading the PC, choosing games,
 * going live and payout details all happen in the desktop app.
 */
export function SharePC({ swiff, release = RELEASE as Release }: { swiff: Swiff; release?: Release }) {
  const { week, setWeek } = swiff;
  const e = estimate(week);

  return (
    <main className="share" data-testid="share">
      <section className="hero share-hero">
        <Backdrop
          className="hero-art"
          image={gameArt(ART, 2)}
          fallback={gameArtFallbacks(ART)}
          position="62% 35%"
          motion={false}
        />
        <div className="hero-scrim" />

        <div className="share-copy">
          <p className="mono hero-kicker">Share your PC</p>
          <h1 className="share-title">Your PC could earn</h1>
          <p className="share-figure">
            <b>
              <Eur n={e.net} />
            </b>
            <span>a month</span>
          </p>
          <p className="share-line">
            After electricity, only while you&rsquo;re away: {plural(week.hoursPerDay, "hour", "hours")} a
            night, {plural(week.daysPerWeek, "night", "nights")} a week.{" "}
            <button
              type="button"
              className="share-link"
              aria-haspopup="dialog"
              onClick={() => swiff.setEstimateOpen(true)}
            >
              How we got this number
            </button>
          </p>

          <TierPicker value={week.tier} onChange={(id) => setWeek({ ...week, tier: id })} />

          <div className="share-actions">
            {HOST_DOWNLOAD_URL ? (
              <>
                <a className="lpill" href={HOST_DOWNLOAD_URL}>
                  Download for Windows
                  <span className="lpill-c">
                    <Glyph name="download" size={18} />
                  </span>
                </a>
                <span className="mono share-fine">Windows, 64-bit</span>
              </>
            ) : (
              <>
                <button type="button" className="lpill" disabled aria-describedby="share-soon">
                  Download for Windows
                  <span className="lpill-c">
                    <Glyph name="download" size={18} />
                  </span>
                </button>
                <span className="mono share-fine" id="share-soon">
                  Coming soon
                </span>
              </>
            )}
          </div>
          <p className="share-note">
            Open it on the PC you want to share. The app reads your hardware and sets your exact rate.{" "}
            <a className="share-link" href="#trust">
              Check the download
            </a>
          </p>
        </div>

        <aside className="inst inst-lift" aria-label="Your week away">
          <AwayDial from={AWAY_FROM} hours={week.hoursPerDay}>
            <div className="dial-count share-count">
              <b>{e.weekHours} h</b>
              <span className="mono">a week away</span>
            </div>
          </AwayDial>
          <div className="inst-cap mono">
            <span>Away window</span>
            <span>{awayWindow(week.hoursPerDay)}</span>
          </div>
        </aside>
      </section>

      <section className="band share-band" aria-label="How sharing works">
        <div className="share-cell">
          <Glyph name="clock" />
          <h2>Only while you&rsquo;re away</h2>
          <p>Sharing stops the moment you touch the keyboard.</p>
        </div>
        <div className="share-cell">
          <Glyph name="lock" />
          <h2>Sandboxed sessions</h2>
          <p>Players get an isolated account with no access to your files or logins.</p>
        </div>
        <div className="share-cell">
          <Glyph name="card" />
          <h2>Paid on the 1st</h2>
          <p>
            Bank, PayPal or Steam wallet, from <Eur n={5} />, no fees.
          </p>
        </div>
        <div className="share-cell share-path">
          <h2 className="mono">How it works</h2>
          <ol>
            <li aria-current="step">
              <b>Estimate</b>
              <small>Here on the website</small>
            </li>
            <li>
              <b>Download</b>
              <small>The button above</small>
            </li>
            <li>
              <b>Set up and go live</b>
              <small>In the app on your PC</small>
            </li>
            <li>
              <b>Get paid</b>
              <small>In the app, on the 1st</small>
            </li>
          </ol>
        </div>
      </section>

      <Trust release={release} />
    </main>
  );
}

/**
 * What a host can check for themselves: their BitLocker key stays theirs,
 * Swiff OS comes off in one click, and every download's SHA-256 is here as
 * text, to compare with Windows' own Get-FileHash before running it.
 */
export function Trust({ release }: { release: Release }) {
  const { host, image } = release;
  return (
    <section className="band share-band share-trust" id="trust" aria-labelledby="trust-title">
      <div className="share-cell">
        <Glyph name="key" />
        <h2 id="trust-title">Your BitLocker key stays yours</h2>
        <p>
          Before anything changes how your PC starts, the app has you save your recovery key. Swiff never
          reads, sends or keeps it.
        </p>
      </div>
      <div className="share-cell">
        <Glyph name="undo" />
        <h2>Remove it in one click</h2>
        <p>
          The boot entry, the partitions and Swiff&rsquo;s key come off, the space goes back to Windows, and
          the app checks Windows starts as before.
        </p>
      </div>
      <div className="share-cell share-sums">
        <h2 className="mono">Check your download</h2>
        {host ? (
          <>
            <p>
              In PowerShell, <code>Get-FileHash .\{host.file}</code> prints this SHA-256:
            </p>
            <dl className="sums">
              <dt>{host.file}</dt>
              <dd className="mono">{host.sha256}</dd>
            </dl>
          </>
        ) : (
          <p>Each download&rsquo;s SHA-256 is published here with it, to check before you run it.</p>
        )}
        {image ? (
          <details className="sums-more">
            <summary className="mono">Swiff OS {image.version}, file by file</summary>
            <dl className="sums">
              {image.files.map((f) => (
                <div key={f.name}>
                  <dt>{f.name}</dt>
                  <dd className="mono">{f.sha256}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/** The four tiers as one radio group on a ruler: arrow keys move the choice, Tab leaves it. */
function TierPicker({ value, onChange }: { value: TierId; onChange: (id: TierId) => void }) {
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const at = TIERS.findIndex((t) => t.id === value);
    const next = TIERS[(at + step + TIERS.length) % TIERS.length]!;
    onChange(next.id);
    group.current?.querySelector<HTMLButtonElement>(`[data-tier="${next.id}"]`)?.focus();
  };

  return (
    <div className="tiers" role="radiogroup" aria-label="Your PC" ref={group} onKeyDown={onKeyDown}>
      {TIERS.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? "tier on" : "tier"}
            data-tier={t.id}
            onClick={() => onChange(t.id)}
          >
            <span>{t.name}</span>
            <small>
              <Eur n={t.rate} decimals={2} />
              /h
            </small>
          </button>
        );
      })}
    </div>
  );
}

type Slider = {
  key: "hoursPerDay" | "daysPerWeek" | "electricity";
  label: string;
  value: (w: Week) => string;
};

const SLIDERS: Slider[] = [
  { key: "hoursPerDay", label: "Hours away per day", value: (w) => `${w.hoursPerDay} h` },
  { key: "daysPerWeek", label: "Days per week", value: (w) => String(w.daysPerWeek) },
  { key: "electricity", label: "Electricity price", value: (w) => `€${euros(w.electricity)}/kWh` },
];

/**
 * How we got this number: the estimate as a worked sum, the week as three
 * sliders, and the example rig behind the tier's rate. A paper sheet over the
 * dimmed page; Escape, the close button or the dim put it away.
 */
export function EstimateSheet({ swiff }: { swiff: Swiff }) {
  const { week, setWeek } = swiff;
  const e = estimate(week);
  const t = tier(week.tier);
  const close = useRef<HTMLButtonElement>(null);

  // Focus moves into the sheet, and back to whatever opened it once it closes:
  // a frame later, once the page behind is no longer inert and can take it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => {
      requestAnimationFrame(() => opener?.focus?.());
    };
  }, []);

  const shut = () => swiff.setEstimateOpen(false);

  return (
    <div className="estimate">
      <div className="estimate-dim" onClick={shut} />
      <section className="estimate-sheet" role="dialog" aria-modal="true" aria-labelledby="estimate-title">
        <header className="estimate-head">
          <h2 id="estimate-title">
            How we got <Eur n={e.net} />
          </h2>
          <button type="button" className="estimate-x" aria-label="Close" onClick={shut} ref={close}>
            <Glyph name="close" size={18} />
          </button>
        </header>

        <div className="sum">
          <p className="sum-row">
            <span>{e.weekHours} h away a week</span>
            <span className="op">×</span>
            <span>55% booked</span>
            <span className="op">×</span>
            <span>4.33 weeks</span>
            <b>{e.streamedHours} h streamed</b>
          </p>
          <p className="sum-row">
            <span>{e.streamedHours} h</span>
            <span className="op">×</span>
            <span>
              <Eur n={t.rate} decimals={2} />
              /h for {withArticle(t.name)} rig
            </span>
            <b>
              <Eur n={e.gross} />
            </b>
          </p>
          <p className="sum-row">
            <span>
              Electricity: {e.streamedHours} h at {t.watts} W, <Eur n={week.electricity} decimals={2} />
              /kWh
            </span>
            <b>
              −<Eur n={e.power} />
            </b>
          </p>
          <p className="sum-row sum-total">
            <span>A month, after electricity</span>
            <b>
              <Eur n={e.net} />
            </b>
          </p>
          <p className="sum-range">
            Quiet to busy months: <Eur n={e.low} /> to <Eur n={e.high} />
          </p>
        </div>

        <h3 className="mono estimate-sub">Try your own week</h3>
        {SLIDERS.map((s) => {
          const { min, max, step } = LIMITS[s.key];
          const value = week[s.key];
          const fill = { "--v": `${(((value - min) / (max - min)) * 100).toFixed(1)}%` } as CSSProperties;
          return (
            <div className="slider" key={s.key}>
              <div className="slider-head">
                <label htmlFor={`week-${s.key}`}>{s.label}</label>
                <b>{s.value(week)}</b>
              </div>
              <div className="slider-track" style={fill}>
                <span className="slider-fill" />
                <span className="slider-knob" />
                <input
                  id={`week-${s.key}`}
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={value}
                  aria-valuetext={s.value(week)}
                  onChange={(event) => setWeek({ ...week, [s.key]: Number(event.target.value) })}
                />
              </div>
            </div>
          );
        })}

        <details className="estimate-more">
          <summary className="mono">Where the rate comes from</summary>
          {t.parts.map((p) => (
            <div className="estimate-part" key={p.part}>
              <span>{p.part}</span>
              <b>
                <Eur n={p.rate} decimals={2} />
              </b>
            </div>
          ))}
          <p>
            An example {t.name} rig. The app on your PC reads its real hardware and sets your exact rate.
            Hosts keep 100% of the tier rate. Your own play time is never shared.
          </p>
        </details>
      </section>
    </div>
  );
}
