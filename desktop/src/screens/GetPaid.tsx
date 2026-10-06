// A10 and A11: payout details, typed in the app, and the month once set up.
//
// Payouts are not open yet. The form is built so the owner never leaves the
// app for it, but nothing typed into it is sent anywhere or kept: saving
// clears it. It is held in this component's state alone, never in storage.

import { useState, type FormEvent } from "react";
import { count, shortGpu } from "../format";
import { LEVELS, levelAt, monthCeiling, type Earnings, type Level } from "../model";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Notice } from "../ui/Notice";
import { Eur, Figure, Kv, Plate, Zone } from "../ui/parts";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

type Method = "bank" | "paypal" | "steam";

const METHODS: { id: Method; name: string }[] = [
  { id: "bank", name: "Bank transfer" },
  { id: "paypal", name: "PayPal" },
  { id: "steam", name: "Steam wallet" },
];

type FieldSpec = { name: string; label: string; placeholder: string; type?: "email" };

const FIELDS: Record<Method, FieldSpec[]> = {
  bank: [
    { name: "account-holder", label: "Account holder", placeholder: "Name on the account" },
    { name: "iban", label: "IBAN", placeholder: "DE00 0000 0000 0000 0000 00" },
    { name: "receipts", label: "Email for receipts", placeholder: "you@example.com", type: "email" },
  ],
  paypal: [
    { name: "paypal", label: "PayPal email", placeholder: "you@example.com", type: "email" },
    { name: "receipts", label: "Email for receipts", placeholder: "you@example.com", type: "email" },
  ],
  steam: [
    { name: "steam-account", label: "Steam account name", placeholder: "Your Steam account" },
    { name: "receipts", label: "Email for receipts", placeholder: "you@example.com", type: "email" },
  ],
};

/** The payout form. Saving sends nothing and keeps nothing: it clears the fields. */
export function PayoutForm({ onSave }: { onSave: () => void }) {
  const [method, setMethod] = useState<Method>("bank");
  const [values, setValues] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setValues({});
    setCleared(true);
    onSave();
  };

  return (
    <form className="payform" onSubmit={submit} autoComplete="off" aria-label="Payout details">
      <div className="segs" role="radiogroup" aria-label="Paid by">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={m.id === method}
            className="sg"
            onClick={() => {
              setMethod(m.id);
              setValues({});
            }}
          >
            <span>{m.name}</span>
            <i className="rl" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="fgrid">
        {FIELDS[method].map((f) => (
          <label key={f.name} className="fld">
            <span className="mono">{f.label}</span>
            <input
              type={f.type ?? "text"}
              name={f.name}
              value={values[f.name] ?? ""}
              placeholder={f.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setCleared(false);
                setValues((v) => ({ ...v, [f.name]: event.target.value }));
              }}
            />
          </label>
        ))}
      </div>
      <div className="trustrow">
        <Glyph name="lock" />
        <span>Nothing here is sent or saved yet.</span>
        <Pill icon="check" type="submit">
          Save payout details
        </Pill>
      </div>
      {cleared ? <Notice>Cleared. Nothing was sent.</Notice> : null}
    </form>
  );
}

/** The level ladder: done, the current level, and what is next. */
function Ladder({ current }: { current: Level }) {
  const at = LEVELS.indexOf(current);
  return (
    <ol className="ladder">
      {LEVELS.map((level, i) => (
        <li key={level.id} className={i < at ? "done" : i === at ? "now" : "next"}>
          <span className="pd" />
          <b>{level.name}</b>
          <span className="mono">{level.hours} h</span>
          <small>{level.perk}</small>
        </li>
      ))}
    </ol>
  );
}

/** A11: the month, payouts, the levels and the rate. Only where there are earnings. */
function SetUp({ view, earnings, onChange }: ScreenProps & { earnings: Earnings; onChange: () => void }) {
  const { month } = earnings;
  const { rate, standing } = view;
  const gpu = view.pc.hardware?.gpu;
  const ceiling = rate ? monthCeiling(rate.total, view.now) : null;
  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{month.name}</p>
          <h1>This month</h1>
          <Figure unit="so far">
            <Eur n={month.amount} />
          </Figure>
          <p className="ln">
            Next payout on {earnings.nextPayout}
            {earnings.accountEnding ? ` to the account ending ${earnings.accountEnding}` : ""}.{" "}
            <button type="button" className="lnk" onClick={onChange}>
              Change payout details
            </button>
          </p>
          {ceiling !== null ? (
            <p className="soft fine">
              Up to <Eur n={ceiling} decimals={0} /> this month at your rate, if you're live 18:00 to midnight
              every day.
            </p>
          ) : null}
        </div>
        <Plate caption={["Month", `${count(month.sessions, "session", "sessions")}, ${month.hours} h`]}>
          <Dial
            progress={ceiling ? month.amount / ceiling : null}
            big={<Eur n={month.amount} />}
            small={
              ceiling !== null ? (
                <>
                  of up to <Eur n={ceiling} decimals={0} />
                </>
              ) : (
                "so far"
              )
            }
          />
        </Plate>
      </section>
      <div className="sz three">
        <Zone title="Payouts">
          {earnings.payouts.map((p) => (
            <div key={p.month} className="hr">
              <div>
                <b>{p.month}</b>
                <small>
                  {count(p.sessions, "session", "sessions")}, {p.hours} h
                </small>
              </div>
              <span className="fig">
                <Eur n={p.amount} decimals={0} />
              </span>
              <span className="ptag">Paid</span>
            </div>
          ))}
        </Zone>
        {standing ? (
          <Zone title="Levels">
            <Ladder current={levelAt(standing.reliableHours)} />
          </Zone>
        ) : null}
        {rate && standing ? (
          <Zone title="Your rate">
            <Figure size="xs" unit="an hour">
              <Eur n={rate.total} />
            </Figure>
            <Kv label={`Hardware${gpu ? `, ${shortGpu(gpu)}` : ""}`}>
              <Eur n={rate.hardware} />
            </Kv>
            <Kv label={`Reliability ${rate.reliability}`}>{Math.round(rate.factor * 100)}%</Kv>
            <Kv label={`Level ${rate.level.name}`}>+{Math.round(rate.level.bonus * 100)}%</Kv>
            <Kv label="Finished, 7 days">
              {standing.finished.done} of {standing.finished.of}
            </Kv>
          </Zone>
        ) : null}
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** Get paid: the payout form until details are saved (demo), then the month. */
export function GetPaid(props: ScreenProps) {
  const { view, actions } = props;
  const [changing, setChanging] = useState(false);
  const { earnings } = view;
  if (earnings && view.payoutSaved && !changing) {
    return <SetUp {...props} earnings={earnings} onChange={() => setChanging(true)} />;
  }
  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Get paid</p>
          <h1>Where should we pay you?</h1>
          {earnings ? (
            <>
              <Figure unit="earned so far">
                <Eur n={earnings.earned} />
              </Figure>
              <p className="ln">
                Paid on the 1st once you reach <Eur n={earnings.firstPayoutAt} decimals={0} />. No fees.
              </p>
            </>
          ) : (
            <p className="ln">Payouts aren't open yet. Nothing you type here is sent or saved.</p>
          )}
        </div>
        <Plate caption={earnings ? ["First payout", earnings.nextPayout] : ["Payouts", "Not open yet"]}>
          {earnings ? (
            <Dial
              progress={earnings.earned / earnings.firstPayoutAt}
              big={<Eur n={earnings.earned} />}
              small={
                <>
                  of <Eur n={earnings.firstPayoutAt} decimals={0} /> to first payout
                </>
              }
            />
          ) : (
            <Dial off big="Not open" small="payouts" />
          )}
        </Plate>
      </section>
      <div className="sz one">
        <PayoutForm
          onSave={() => {
            setChanging(false);
            actions.savePayout();
          }}
        />
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
