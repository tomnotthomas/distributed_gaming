// Pairing this PC with the owner's Steam account (pairing.ts): one click opens
// the page where they sign in with Steam and add the PC, and this screen
// carries on by itself once they have. Lanterel makes the machine key and
// keeps it on this PC: there is nothing to copy or type.

import type { Pairing } from "../model";
import { Glyph } from "../ui/Glyph";
import { Kv, Plate, Zone } from "../ui/parts";
import { Notice } from "../ui/Notice";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

/** The statement at the top: where pairing stands, and the one thing to do next. */
function statement(pairing: Pairing): { title: string; line: string } {
  switch (pairing.kind) {
    case "checking":
      return { title: "Checking this PC's account", line: "Lanterel reads the key it keeps for this PC." };
    case "unpaired":
      return {
        title: "Pair this PC with Steam",
        line: "Sign in with the Steam account you play with, and this PC is yours on Lanterel. There's no key to copy.",
      };
    case "waiting":
      return {
        title: "Add this PC in your browser",
        line: "Sign in with Steam on the page that just opened, then add this PC there. This screen carries on by itself.",
      };
    case "failed":
      return { title: "This PC isn't paired yet", line: pairing.why };
    case "paired":
      return {
        title: "This PC is paired",
        line: pairing.owner
          ? `It's paired with the Steam account ${pairing.owner}. If that isn't yours, pair again with a new key. Its key stays encrypted on this PC.`
          : "It's yours on Lanterel, with the Steam account you signed in with. Its key stays encrypted on this PC.",
      };
  }
}

/** The plate's caption: the step, and where it stands. */
const STANDING: Record<Pairing["kind"], string> = {
  checking: "Checking",
  unpaired: "Not paired",
  waiting: "Waiting for you",
  failed: "Not paired",
  paired: "Paired",
};

/** This PC's pairing with its owner's Steam account, and the next step to it. */
export function PairSetup({ view, actions, go }: ScreenProps) {
  const { pairing } = view;
  const { title, line } = statement(pairing);
  const paired = pairing.kind === "paired";

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">Account</p>
          <h1>{title}</h1>
          <p className="ln">{line}</p>
          {pairing.kind === "waiting" ? (
            <p className="ln soft">
              The page shows the same code as this screen. Add the PC only if they match.
            </p>
          ) : null}
          {pairing.kind === "waiting" && pairing.unanswered ? (
            <Notice icon="offline">
              Lanterel's server isn't answering right now. This screen keeps asking.
            </Notice>
          ) : null}
          {pairing.kind === "unpaired" || pairing.kind === "failed" ? (
            <div className="acts">
              <Pill icon={pairing.kind === "failed" ? "refresh" : "arrow"} onClick={() => actions.pair()}>
                {pairing.kind === "failed" ? "Pair again" : "Pair with Steam"}
              </Pill>
            </div>
          ) : null}
          {pairing.kind === "waiting" ? (
            <div className="acts">
              <a className="inst" href={pairing.link} target="_blank" rel="noreferrer">
                <Glyph name="arrow" size={15} />
                Open the page again
              </a>
              <button type="button" className="lnk" onClick={actions.cancelPairing}>
                Cancel
              </button>
            </div>
          ) : null}
        </div>
        <Plate caption={["Account", STANDING[pairing.kind]]}>
          <div className="mplatebody">
            {pairing.kind === "waiting" ? (
              <p className="paircode" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
                {pairing.code}
              </p>
            ) : (
              <span className="mono pairstate">
                {paired ? <Glyph name="check" /> : null}
                {paired ? "Paired with Steam" : pairing.kind === "checking" ? "Checking" : "Not paired"}
              </span>
            )}
          </div>
        </Plate>
      </section>

      <div className="sz three">
        <Zone title="Steam sign-in">
          <p className="soft">
            Lanterel asks Steam who you are, on Steam's own page. It never sees your password.
          </p>
        </Zone>
        <Zone
          title="This PC"
          action={
            paired ? (
              <button type="button" className="lnk" onClick={() => actions.pair({ fresh: true })}>
                Pair again
              </button>
            ) : undefined
          }
        >
          <Kv label="Paired">{paired ? "Yes" : pairing.kind === "checking" ? "Checking" : "No"}</Kv>
          <Kv label="Steam account">
            {paired ? (pairing.owner === undefined ? "Checking" : (pairing.owner ?? "Unknown")) : "None yet"}
          </Kv>
          <Kv label="Machine ID">{paired ? pairing.machineId : "Given when paired"}</Kv>
        </Zone>
        <Zone title="Next">
          <p className="soft">{paired ? "Pick the games players can play." : "Pair this PC first."}</p>
          {paired ? (
            <div className="acts">
              <Pill icon="arrow" onClick={() => go("games")}>
                Choose games
              </Pill>
            </div>
          ) : null}
        </Zone>
      </div>
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}
