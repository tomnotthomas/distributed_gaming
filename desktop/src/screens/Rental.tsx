// Rental mode, one thing at a time. Its three steps (get the PC ready, install
// Swiff OS, confirm the key) hang under it in the rail; this screen shows only
// the one the owner is on. The title always says what to do, the plate shows
// the one thing they look for (the setting and its value, the code, the blue
// screen, the install's progress), the strip under it shows how, and every
// other fact waits behind one quiet row of links.
//
// Everything that needs no one runs by itself after one OK: the checks, the
// partitions, writing Swiff OS, the boot entry, queuing the key and pointing
// the next start at Swiff OS. The flow stops only where the owner must act:
// Windows' administrator prompt, a BIOS setting, writing down the code and
// pressing a key at the blue screen, and going live.

import { useEffect, useState, type ReactNode } from "react";
import type { PlanStep, RentalPlan, RentalRead } from "../../rental.cjs";
import { clock } from "../format";
import type { RentalRun } from "../model";
import { mmss, timeLeft } from "../progress";
import {
  BIOS_ASKS,
  biosPath,
  biosTitle,
  chosenTarget,
  codeGroups,
  drivesLine,
  firmwareChecks,
  gb,
  hintOf,
  pcChecks,
  failureOf,
  firmwareGuide,
  otherRoom,
  passBytes,
  removesDisk,
  removesKey,
  rentalScreen,
  rentalStepAt,
  RUNNING_TITLE,
  runningTitleOf,
  type BiosId,
  type RentalCheck,
  type Waiting,
  type WindowsTodo,
} from "../rental";
import { Dial } from "../ui/Dial";
import { Glyph } from "../ui/Glyph";
import { Eur, Kv, Plate, Zone } from "../ui/parts";
import { Pill } from "../ui/Pill";
import type { ScreenProps } from "./types";

// --- the strip: a to-do of several steps, one tile each ----------------------------------

/** What a tile shows besides its words: keys to press, a setting, the screen's own text, the app's button. */
type Visual =
  | { keys: string[] }
  | { setting: [string, string] }
  | { screen: string }
  | { app: "again" | "wait" | "done" };
type Tile = { title: string; text: string; visual: Visual };

/** The BIOS trip for these settings, with this PC's key and menu paths where Swiff knows its firmware. */
function biosTrip(ids: BiosId[], read: RentalRead | null): Tile[] {
  const guide = read ? firmwareGuide(read) : null;
  const keys = guide?.keys ?? ["F2", "Del"];
  return [
    {
      title: "Open the BIOS",
      text:
        guide?.name === "Surface"
          ? "Turn the PC off. Hold Volume up, press and let go of Power, and keep holding Volume up until the Surface logo goes."
          : `Restart the PC. While it starts, press ${keys.join(" or ")} a few times.`,
      visual: { keys },
    },
    ...ids.map((id) => ({
      title: BIOS_ASKS[id].title,
      text: (read && biosPath(read, id)) ?? BIOS_ASKS[id].hint,
      visual: { setting: [BIOS_ASKS[id].setting, BIOS_ASKS[id].value] as [string, string] },
    })),
    {
      title: "Save and exit",
      text: "Choose Save & Exit, often F10. Windows starts again.",
      visual: { keys: ["F10"] },
    },
    { title: "Check again", text: "Open Lanterel and press Check again.", visual: { app: "again" } },
  ];
}

/** Turning BitLocker off for the games drive, in Windows: Swiff OS cannot read an encrypted drive. */
function bitlockerTrip(letter: string): Tile[] {
  return [
    {
      title: "Open BitLocker",
      text: "Search Windows for Manage BitLocker and open it.",
      visual: { keys: ["Win"] },
    },
    {
      title: `Turn it off for ${letter}:`,
      text: "Choose Turn off BitLocker next to the drive.",
      visual: { setting: [`${letter}: BitLocker`, "Off"] },
    },
    {
      title: "Wait for it to finish",
      text: "Windows decrypts the drive. It can take a while on a big drive.",
      visual: { app: "wait" },
    },
    { title: "Check again", text: "Come back here and press Check again.", visual: { app: "again" } },
  ];
}

/**
 * Saving the BitLocker recovery key, in Windows' own words: its BitLocker
 * page offers the Microsoft account, a file and printing.
 */
function recoveryTrip(drives: string[]): Tile[] {
  const first = drives[0] ?? "C";
  return [
    {
      title: "Open BitLocker",
      text: "Press Open BitLocker, or search Windows for Manage BitLocker.",
      visual: { keys: ["Win"] },
    },
    {
      title: "Back up your recovery key",
      text: `Choose it next to ${drivesLine(drives)}`,
      visual: { setting: [`${first}: BitLocker`, "Back up"] },
    },
    {
      title: "Keep it off this PC",
      text: "Save it to your Microsoft account, to a file on a USB stick, or print it.",
      visual: { setting: ["Save to", "Microsoft account"] },
    },
    { title: "Say so here", text: "Then press I saved my key.", visual: { app: "done" } },
  ];
}

/** Where Windows Home keeps the key, and where to look when Windows' page didn't open. */
const RecoveryHome = () => (
  <ul className="mlist">
    <li>
      On Windows Home there's no Back up option: Device encryption saved the key to your Microsoft account by
      itself.
    </li>
    <li>
      On your phone, open{" "}
      <a href="https://aka.ms/myrecoverykey" target="_blank" rel="noreferrer">
        aka.ms/myrecoverykey
      </a>
      , sign in, and check this PC's key is listed.
    </li>
  </ul>
);

/**
 * shim's MokManager, screen by screen, in its own words: enrolling Swiff's
 * key, or removing it. Swiff queues the request with MokTimeout -1, so the
 * menu comes at once and waits: no 10-second countdown to beat.
 */
function blueScreen(remove = false): Tile[] {
  const verb = remove ? "Delete" : "Enroll";
  return [
    {
      title: `Choose ${verb} MOK`,
      text: "The blue screen waits for you. Arrow down, then Enter.",
      visual: { screen: `Perform MOK management\n  Continue boot\n> ${verb} MOK` },
    },
    { title: "Choose Continue", text: "", visual: { screen: `[${verb} MOK]\n> Continue` } },
    { title: "Choose Yes", text: "", visual: { screen: `${verb} the key(s)?\n> Yes` } },
    {
      title: "Type your code",
      text: "Then press Enter. Nothing shows as you type.",
      visual: { screen: "Password:" },
    },
    {
      title: "Choose Reboot",
      text: "Windows starts again.",
      visual: { screen: "Perform MOK management\n> Reboot" },
    },
  ];
}

/** A tile's picture: the keys to press, the setting and its value, the screen's text, or the app's button. */
function Visualize({ v }: { v: Visual }) {
  if ("keys" in v)
    return (
      <span className="mvis keys" aria-hidden="true">
        {v.keys.map((k, i) => (
          <span key={k} className="mk-wrap">
            {i ? <span className="mk-or">or</span> : null}
            <kbd className="mk">{k}</kbd>
          </span>
        ))}
      </span>
    );
  if ("setting" in v)
    return (
      <span className="mvis setting" aria-hidden="true">
        <span>{v.setting[0]}</span>
        <b>{v.setting[1]}</b>
      </span>
    );
  if ("screen" in v)
    return (
      <span className="mvis screen" aria-hidden="true">
        {v.screen}
      </span>
    );
  return (
    <span className="mvis appbtn" aria-hidden="true">
      <Glyph name={v.app === "wait" ? "clock" : v.app === "done" ? "check" : "refresh"} size={28} />
    </span>
  );
}

/** The strip under the plate: how to do the one thing, tile by tile, with any note after it. */
function Strip({ tiles, label, children }: { tiles: Tile[]; label: string; children?: ReactNode }) {
  return (
    <div className="sz one">
      <section className="mmulti" aria-label={label}>
        <h2 className="mono">{label}</h2>
        <ol className="mstrip">
          {tiles.map((t, i) => (
            <li key={t.title}>
              <Visualize v={t.visual} />
              <span className="mono mnum2">{String(i + 1).padStart(2, "0")}</span>
              <b>{t.title}</b>
              {t.text ? <span className="mtext">{t.text}</span> : null}
            </li>
          ))}
        </ol>
        {children}
      </section>
    </div>
  );
}

/**
 * The way out when the blue screen is not the one the strip shows: never into
 * Windows from there. Continue boot without the key goes on into Windows in
 * the same power-on, which changes what Windows Hello's PIN is sealed to.
 */
const NoContinue = () => (
  <p className="mnote">
    <Glyph name="warning" size={16} />
    <span>
      No Enroll MOK in the menu? Don't choose Continue boot: Windows would then ask you to set your PIN again.
      Hold the power button until the PC turns off, then turn it on again. Windows starts as usual.
    </span>
  </p>
);

// --- the plate: the one thing the owner looks for ------------------------------------------

type Row = { name: string; value: string; wait?: boolean };

/** The plate for settings: each one with the value it must have, or what it waits for. */
function SettingsPlate({
  where,
  rows,
  checking,
  at,
  label,
}: {
  where: string;
  rows: Row[];
  checking: boolean;
  at: string;
  label?: string;
}) {
  return (
    <Plate caption={[where, checking ? "Checking now" : at ? `Checked at ${at}` : ""]}>
      <div className="mplatebody">
        <div className="mtarget">
          <p className="mono">{label ?? (rows.every((r) => r.wait) ? "Waiting for" : "Set to")}</p>
          {rows.map((r) => (
            <div key={r.name} className={r.wait ? "mtrow wait" : "mtrow"}>
              <span>{r.name}</span>
              {checking && !r.wait ? <i className="mspin" aria-label="Checking" /> : <b>{r.value}</b>}
            </div>
          ))}
        </div>
      </div>
    </Plate>
  );
}

/** The plate for a one-time key code, in two halves of four. */
function CodePlate({ code, caption }: { code: string; caption: [string, string] }) {
  return (
    <Plate caption={caption}>
      <div className="mplatebody">
        <p className="mplatecode" aria-label={`Key code ${code.split("").join(" ")}`}>
          {codeGroups(code)}
        </p>
      </div>
    </Plate>
  );
}

/** The plate for the blue screen after the restart, in its own words. */
function ScreenPlate({ text }: { text: string }) {
  return (
    <Plate caption={["After the restart", "Blue screen"]}>
      <div className="mplatebody">
        <span className="mvis screen big mplatescreen" aria-hidden="true">
          {text}
        </span>
      </div>
    </Plate>
  );
}

const ReadyPlate = ({ small }: { small: string }) => (
  <Plate caption={["This PC", "Ready"]}>
    <Dial progress={1} big="Ready" small={small} />
  </Plate>
);

// --- the install, as it runs ----------------------------------------------------------------

/** 1,273,547,479 bytes → "1.2 GB": a download's size, with a tenth so it is seen to move. */
const gbOf = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Seconds since `from`, ticking once a second while shown. */
function useSince(from: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return from === null ? 0 : Math.max(0, (now - from) / 1000);
}

/** The plan's steps as they run: done, running (with its bar and clock or bytes), next, or where it stopped. */
function RunList({
  plan,
  run,
  elapsed,
  restarting,
}: {
  plan: RentalPlan;
  run: RentalRun;
  elapsed: number;
  restarting?: boolean;
}) {
  const label = plan.kind === "install" ? "The install, step by step" : "Step by step";
  return (
    <div className="sz one">
      <section className="mmulti" aria-label={label}>
        <h2 className="mono">{label}</h2>
        <ol className="mrun">
          {plan.steps.map((s) => {
            const state = run.steps[s.id];
            const restart = restarting && s.ops.some((o) => o.op === "restart");
            const row =
              state === "done"
                ? "done"
                : state === "running" || restart
                  ? "now"
                  : state === "failed"
                    ? "fail"
                    : "next";
            const bytes = row === "now" && run.progress?.id === s.id ? run.progress : null;
            return (
              <li key={s.id} className={row} aria-current={row === "now" ? "step" : undefined}>
                <span className="mrun-mark">
                  {row === "done" ? (
                    <Glyph name="check" size={13} />
                  ) : row === "fail" ? (
                    <Glyph name="warning" size={13} />
                  ) : (
                    <i />
                  )}
                </span>
                <span className="mrun-name">{row === "now" ? runningTitleOf(plan, s) : s.title}</span>
                <span className="mrun-bar" aria-hidden="true">
                  {row === "now" ? (
                    bytes ? (
                      <i className="det" style={{ width: `${(bytes.done / bytes.total) * 100}%` }} />
                    ) : (
                      <i className="indet" />
                    )
                  ) : null}
                </span>
                <span className="mono mrun-t">
                  {row === "done"
                    ? "Done"
                    : row === "fail"
                      ? "Stopped"
                      : row === "now"
                        ? bytes
                          ? `${bytes.pass.name}: ${passBytes(bytes.pass)}`
                          : mmss(elapsed)
                        : ""}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

// --- everything else, folded -----------------------------------------------------------------

/** A check's value for the fold: the same facts as before, said plainly. */
function CheckList({ checks }: { checks: RentalCheck[] }) {
  return (
    <>
      {checks.map((c) => {
        const mark = c.state === "bios" || c.state === "blocked";
        return (
          <Kv key={c.id} label={c.label}>
            <span className={mark ? "rck warn" : "rck"}>
              {mark ? <Glyph name="warning" size={14} /> : null}
              {c.value}
            </span>
          </Kv>
        );
      })}
    </>
  );
}

function PlanSteps({ plan }: { plan: RentalPlan }) {
  const [commands, setCommands] = useState(false);
  return (
    <>
      <ol className="mnum">
        {plan.steps.map((s) => (
          <li key={s.id}>
            {s.title}
            {commands ? <pre className="rcmd">{s.commands.join("\n")}</pre> : null}
          </li>
        ))}
      </ol>
      <p>
        <button type="button" className="lnk" onClick={() => setCommands((on) => !on)}>
          {commands ? "Hide commands" : "Show commands"}
        </button>
      </p>
    </>
  );
}

const SecureBootHelp = () => (
  <ul className="mlist">
    <li>If Secure Boot is in Setup Mode, restore the factory keys first. Then turn Secure Boot on.</li>
    <li>On some BIOSes, Secure Boot turns on only once CSM (Legacy boot) is off.</li>
  </ul>
);

type More = { id: string; label: string; body?: ReactNode; onClick?: () => void };

/** One quiet row of links: each opens its drawer under the row, or does its one thing. */
function Links({ items }: { items: More[] }) {
  const [open, setOpen] = useState<string[]>([]);
  if (!items.length) return null;
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  return (
    <div className="sz one">
      <div className="mbar">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            className="lnk"
            aria-expanded={i.body ? open.includes(i.id) : undefined}
            onClick={i.onClick ?? (() => toggle(i.id))}
          >
            {i.label}
          </button>
        ))}
      </div>
      {items
        .filter((i) => i.body && open.includes(i.id))
        .map((i) => (
          <div key={i.id} className="mdrawer">
            <Zone title={i.label}>{i.body}</Zone>
          </div>
        ))}
    </div>
  );
}

/** What Lanterel checked: the firmware's checks and this PC's, behind one link. */
const checkedLink = (read: RentalRead, target: string | null): More => ({
  id: "checks",
  label: "What Lanterel checked",
  body: (
    <div className="mcols">
      <div>
        <CheckList checks={firmwareChecks(read)} />
      </div>
      <div>
        <CheckList checks={pcChecks(read, target)} />
      </div>
    </div>
  ),
});

/** Remove Swiff OS's disk part, going on by itself after its key's restart. */
const continuesRemoval = (plan: RentalPlan, read: RentalRead | null): boolean =>
  plan.kind === "remove" && plan.phase === "disk" && read?.removal?.state === "finish";

/** The quiet way back to the key's removal, should its blue screen not have taken the code. */
const rekeyLink = (actions: ScreenProps["actions"]): More => ({
  id: "rekey",
  label: "The blue screen didn't take the code",
  onClick: () => actions.previewRental("remove", { key: true }),
});

const planLink = (plan: RentalPlan): More => ({
  id: "steps",
  label: `${plan.kind === "install" ? "What the install does" : removesDisk(plan) ? "What removing does" : "What the restart does"}, ${plan.steps.length} steps`,
  body: <PlanSteps plan={plan} />,
});

// --- what went wrong, said plainly ----------------------------------------------------------

/** Windows' prompt, as the owner meets it: the strip for "Windows didn't give permission". */
const WINDOWS_ASKS: Tile[] = [
  {
    title: "Press Ask again",
    text: "Windows shows its prompt in front of this app.",
    visual: { app: "again" },
  },
  {
    title: "Click Yes",
    text: "Do you want to allow this app to make changes to your device?",
    visual: { setting: ["Lanterel Host", "Yes"] },
  },
  {
    title: "No prompt?",
    text: "Look for a flashing shield on the taskbar and click it.",
    visual: { setting: ["Taskbar", "Shield"] },
  },
];

/** What changed so far: the safety fact, after an info glyph. */
const Changed = ({ children }: { children: ReactNode }) => (
  <p className="mchanged">
    <Glyph name="info" size={15} />
    <span>{children}</span>
  </p>
);

/** What was sent to Swiff, and when. */
export const Sent = ({ at }: { at: number }) => (
  <p className="msent">
    <Glyph name="check" size={14} />
    Saved at {clock(at)} for Lanterel: the error, the step and this PC's checks.
  </p>
);

/** The exact error, in mono, with Send details to Swiff under it unless that is the screen's own button. */
function Detail({ error, sent, onSend }: { error: string; sent: boolean; onSend: (() => void) | null }) {
  return (
    <>
      <pre className="mdetail">{error}</pre>
      {onSend && !sent ? (
        <p>
          <button type="button" className="lnk" onClick={onSend}>
            Send details to Lanterel
          </button>
        </p>
      ) : null}
    </>
  );
}

// --- the screen ---------------------------------------------------------------------------------

/** The plate's rows for the to-dos in Windows and the BIOS, then what only an update brings. */
function rowsOf(todos: WindowsTodo[], bios: BiosId[], waiting: Waiting[]): Row[] {
  const wait = (w: Waiting): Row => ({ name: w.setting[0], value: w.setting[1], wait: true });
  return [
    ...todos.map((t) => ({ name: t.setting[0], value: t.setting[1] })),
    ...bios.map((id) => ({ name: BIOS_ASKS[id].setting, value: BIOS_ASKS[id].value })),
    ...waiting.map(wait),
  ];
}

/** "Lanterel OS goes on 24 GB of C:" or "… of free space on disk 1". */
function placeLine(read: RentalRead, target: string | null): string {
  const where = chosenTarget(read, target);
  if (!where) return `Lanterel OS needs ${gb(read.need)} next to Windows.`;
  return where.kind === "shrink"
    ? `Lanterel OS goes on ${gb(read.need)} of ${where.letter}:, next to Windows. Your files stay where they are.`
    : `Lanterel OS goes on ${gb(read.need)} of free space on disk ${where.disk}, next to Windows. Your files stay where they are.`;
}

/** The Rental mode screen: the one thing to do now, its plate, how to do it, and the rest one link away. */
export function RentalSetupScreen({ view, actions, go }: ScreenProps) {
  const setup = view.rental;
  const { read, reading, target, run } = setup;
  const s = rentalScreen(setup);
  const at = rentalStepAt(setup);
  const elapsed = useSince(
    run.status === "restarting" || run.status === "running" || run.status === "starting"
      ? run.stepStartedAt
      : null,
  );
  const checkedAt = setup.readAt ? clock(setup.readAt) : "";
  const removing =
    s.kind === "finish" ||
    s.kind === "removed" ||
    (s.kind === "restart" && Boolean(s.removing)) ||
    ("plan" in s && (s.plan?.kind === "remove" || (s.kind === "failed" && removesDisk(s.plan))));
  const label =
    s.kind === "back"
      ? "Rental mode, back in Windows"
      : removing
        ? "Rental mode, removing"
        : at >= 3
          ? "Rental mode, installed"
          : `Rental mode, step ${at + 1} of 3`;
  const again = (
    <Pill icon="refresh" onClick={actions.checkRental} disabled={reading}>
      {reading ? "Checking" : "Check again"}
    </Pill>
  );

  let title = "";
  let line: ReactNode = "";
  let extra: ReactNode = null;
  let action: ReactNode = null;
  let plate: ReactNode = null;
  let below: ReactNode = null;
  const links: More[] = [];

  switch (s.kind) {
    case "reading":
      title = "Checking this PC";
      line = "This takes a few seconds.";
      plate = (
        <Plate caption={["This PC", "Checking now"]}>
          <Dial live progress={null} big="…" small="checking" />
        </Plate>
      );
      break;
    case "unread":
      title = "Check didn't finish";
      line = "Windows didn't answer in time. Try again.";
      action = (
        <Pill icon="refresh" onClick={actions.checkRental}>
          Check again
        </Pill>
      );
      plate = (
        <Plate caption={["This PC", "Not checked"]}>
          <Dial off big="Not checked" small="try again" />
        </Plate>
      );
      break;
    case "windows": {
      const todo = s.todos[0]!;
      title = todo.title;
      line = todo.line;
      action = again;
      if (s.todos.length > 1)
        extra = (
          <p className="mstatus">After this: {s.todos[1]!.title.replace(/^\w/, (c) => c.toLowerCase())}.</p>
        );
      else if (s.bios.length)
        extra = (
          <p className="mstatus">
            After this: {biosTitle(s.bios).replace(/^\w/, (c) => c.toLowerCase())} in the BIOS.
          </p>
        );
      const rows = rowsOf(s.todos, [], s.waiting);
      plate = (
        <SettingsPlate
          where={rows.length === 1 ? "In Windows" : "This PC"}
          rows={rows}
          checking={reading}
          at={checkedAt}
        />
      );
      if (todo.id === "games" && read?.games)
        below = <Strip tiles={bitlockerTrip(read.games.letter)} label="In Windows" />;
      break;
    }
    case "bios": {
      title = biosTitle(s.bios);
      line =
        s.bios.length === 1
          ? "It's a BIOS setting, so you change it yourself. It takes a few minutes."
          : s.bios.length === 2
            ? "Both are in the BIOS, so you change them yourself. One trip does it."
            : "They're all in the BIOS, so you change them yourself. One trip does it.";
      action = again;
      plate = (
        <SettingsPlate
          where={s.waiting.length ? "This PC" : "In the BIOS"}
          rows={rowsOf([], s.bios, s.waiting)}
          checking={reading}
          at={checkedAt}
        />
      );
      below = <Strip tiles={biosTrip(s.bios, read)} label="In the BIOS" />;
      break;
    }
    case "unsigned":
      title = "Lanterel OS's files didn't pass the check";
      line =
        "The Lanterel OS files on this PC aren't the ones Lanterel signed, so Lanterel won't install them. Put Lanterel's own files in their place, then check again.";
      action = (
        <Pill icon="refresh" onClick={actions.checkRental}>
          Check again
        </Pill>
      );
      plate = (
        <SettingsPlate
          where="This PC"
          rows={[{ name: "Lanterel OS", value: "Not signed by Lanterel", wait: true }]}
          checking={reading}
          at={checkedAt}
        />
      );
      break;
    case "almost": {
      const gpu = s.waiting.some((w) => w.id === "gpu");
      const image = s.waiting.some((w) => w.id === "image");
      const d = setup.download ?? { status: "idle" };
      const rows = s.waiting.map((w) =>
        w.id === "gpu"
          ? { name: "Graphics card support", value: "Lanterel OS update", wait: true }
          : { name: "Lanterel OS", value: "Download from Lanterel", wait: true },
      );
      title = "Almost ready";
      line = gpu
        ? "Everything else on this PC is ready. Rental mode starts with the Lanterel OS update that supports this graphics card."
        : "Everything else on this PC is ready. Download Lanterel OS: Lanterel Host checks Lanterel signed every part before it keeps it.";
      plate = <SettingsPlate where="This PC" rows={rows} checking={reading} at={checkedAt} />;
      if (!image) break;
      if (d.status === "running") {
        const unpacking = d.phase === "unpack";
        const left = d.total ? timeLeft(d.meter, d.total) : null;
        title =
          d.phase === "check"
            ? "Checking Lanterel OS's release"
            : unpacking
              ? "Unpacking Lanterel OS"
              : "Downloading Lanterel OS";
        line =
          `${d.total ? `${gbOf(d.done)} of ${gbOf(d.total)}. ${left ?? ""}` : "Checking Lanterel signed it."} Keep the PC on. If it stops, it carries on where it stopped.`.replace(
            /\s+/g,
            " ",
          );
        const percent = d.total ? Math.floor((d.done / d.total) * 100) : 0;
        plate = (
          <Plate
            caption={[
              d.total ? `${percent} percent` : "Lanterel OS",
              left ? left.replace(/\.$/, "") : "Measuring",
            ]}
          >
            <Dial
              live
              progress={d.total ? d.done / d.total : null}
              big={d.total ? gbOf(d.done) : "…"}
              small={d.total ? `of ${gbOf(d.total)}${unpacking ? ", unpacking" : ""}` : "checking"}
            />
          </Plate>
        );
      } else if (d.status === "failed") {
        title = "Lanterel OS's download stopped";
        line = d.error;
        action = d.retry ? (
          <Pill icon="refresh" onClick={actions.downloadImage}>
            Try again
          </Pill>
        ) : (
          again
        );
        plate = (
          <Plate caption={["Lanterel OS", "Not downloaded"]}>
            <Dial off cut big="Stopped" small={d.retry ? "try again" : "update"} />
          </Plate>
        );
      } else
        action = (
          <Pill icon="arrow" onClick={actions.downloadImage}>
            Download Lanterel OS
          </Pill>
        );
      break;
    }
    case "ready": {
      title = "Install rental mode";
      line = read ? placeLine(read, target) : "";
      action = (
        <Pill icon="arrow" onClick={() => actions.previewRental("install")}>
          See the install
        </Pill>
      );
      const where = read && chosenTarget(read, target);
      const other = read?.targets.find((t) => t.id !== where?.id);
      if (other)
        extra = (
          <p className="mstatus">
            <button type="button" className="lnk" onClick={() => actions.chooseRentalTarget(other.id)}>
              {other.kind === "shrink" ? `Use ${other.letter}: instead` : `Use disk ${other.disk} instead`}
            </button>
          </p>
        );
      plate = <ReadyPlate small="this PC" />;
      break;
    }
    case "resume":
      title = "The install didn't finish";
      line =
        "Part of Lanterel OS is on this PC already. Continue, and Lanterel picks up where it stopped. Windows and your files are fine.";
      action = (
        <Pill icon="arrow" onClick={() => actions.previewRental("install")}>
          Continue the install
        </Pill>
      );
      plate = (
        <Plate caption={["This PC", "Install not finished"]}>
          <Dial progress={null} big="Paused" small="part way" />
        </Plate>
      );
      links.push({
        id: "undo",
        label: "Undo what was done",
        onClick: () => actions.previewRental("remove"),
      });
      break;
    case "recovery": {
      const drives = drivesLine(s.drives);
      const many = s.drives.length > 1;
      title = many ? "Save your BitLocker recovery keys" : "Save your BitLocker recovery key";
      line = `${drives} ${many ? "are" : "is"} encrypted, and a restart can ask for ${many ? "their keys" : "its key"}: keep a copy you can reach from another device.`;
      extra = (
        <p className="mstatus">
          <Glyph name="info" size={15} />
          Lanterel never reads, sends or keeps your key.
        </p>
      );
      action = (
        <>
          <Pill icon="check" onClick={actions.saveRecoveryKey}>
            I saved my key
          </Pill>
          <button type="button" className="lnk" onClick={actions.openBitLocker}>
            Open BitLocker
          </button>
        </>
      );
      plate = (
        <SettingsPlate
          where={`${drives} BitLocker`}
          label="Keep the key in one of"
          rows={[
            { name: "Microsoft account", value: "aka.ms/myrecoverykey" },
            { name: "A file", value: "USB stick or another PC" },
            { name: "Paper", value: "Printed" },
          ]}
          checking={false}
          at="Recovery key"
        />
      );
      below = (
        <Strip tiles={recoveryTrip(s.drives)} label="In Windows">
          {setup.bitlockerPage === "failed" ? (
            <p className="mnote" role="status">
              <Glyph name="warning" size={16} />
              <span>
                Windows didn't open its BitLocker page. Search Windows for Manage BitLocker. On Windows Home,
                it's Settings, Privacy &amp; security, Device encryption, and the key is in your Microsoft
                account.
              </span>
            </p>
          ) : null}
        </Strip>
      );
      links.push({ id: "home", label: "No Back up option?", body: <RecoveryHome /> });
      break;
    }
    case "finish": {
      const waits = Boolean(setup.removalTried) && !setup.planning;
      title = "Finishing removing Lanterel OS";
      line = waits
        ? "Lanterel OS is still on the disk. Press Try again to remove it."
        : "Lanterel now takes Lanterel OS off the disk by itself, and its space goes back to Windows. Windows may ask once more for permission.";
      if (waits)
        action = (
          <Pill icon="undo" onClick={actions.finishRemoval}>
            Try again
          </Pill>
        );
      plate = (
        <Plate caption={["Remove Lanterel OS", "Windows may ask once"]}>
          <Dial progress={0.5} big="Last part" small="then a restart" />
        </Plate>
      );
      links.push(rekeyLink(actions));
      break;
    }
    case "removed": {
      const fine = s.ok !== false;
      title = fine ? "Lanterel OS is off this PC" : "Lanterel OS is off, but check this";
      line = fine
        ? "Windows started as usual after the restart, and the space is Windows' again."
        : "Something isn't as it was before Lanterel OS. It's marked below.";
      action = (
        <Pill icon="check" onClick={actions.seenRemoval}>
          Done
        </Pill>
      );
      plate = (
        <SettingsPlate
          where="After the restart"
          label="Checked"
          rows={s.checks.map((c) => ({ name: c.label, value: c.value, wait: !c.ok }))}
          checking={false}
          at={checkedAt}
        />
      );
      break;
    }
    case "preview": {
      const { plan } = s;
      if (plan.mok) {
        const remove = removesKey(plan);
        title = "Write down this code";
        line = remove
          ? "Or take a photo. You type it on a blue screen after the restart, to remove Lanterel's key."
          : "Or take a photo. You type it on a blue screen after the restart, when this app is closed.";
        extra = (
          <p className="mstatus">
            <Glyph name="info" size={15} />
            {plan.kind === "install"
              ? "Then Lanterel runs every step by itself. Windows asks once for permission."
              : plan.kind === "remove"
                ? "Windows asks once for permission. Back in Windows, open Lanterel: it takes Lanterel OS off the disk by itself."
                : "Windows asks once for permission. Then Lanterel gets the restart ready."}
          </p>
        );
        action = (
          <>
            <Pill icon="arrow" onClick={actions.runRental}>
              {plan.kind === "install" ? "Install" : remove ? "Remove the key" : "Confirm the key"}
            </Pill>
            <button type="button" className="lnk" onClick={actions.closeRentalPreview}>
              Back
            </button>
          </>
        );
        plate = <CodePlate code={plan.mok.code} caption={["Your key code", "Write it down"]} />;
        below = <Strip tiles={blueScreen(remove)} label="After the restart, on the blue screen" />;
      } else {
        const off = removesDisk(plan);
        title = off ? "Remove Lanterel OS" : "Start Lanterel OS";
        line =
          plan.kind === "remove"
            ? "Lanterel OS comes off this PC, and the drive it came from gets its space back. One restart then checks Windows starts as usual. Your files stay where they are."
            : off
              ? "Lanterel OS comes off this PC, and the drive it came from gets its space back. Your files stay where they are."
              : "The PC restarts into Lanterel OS. Its next restart after that starts Windows.";
        action = (
          <>
            <Pill icon={off ? "undo" : "play"} onClick={actions.runRental}>
              {off ? "Remove Lanterel OS" : "Start Lanterel OS"}
            </Pill>
            <button type="button" className="lnk" onClick={actions.closeRentalPreview}>
              Back
            </button>
          </>
        );
        plate = (
          <Plate caption={["Windows asks once", `${plan.steps.length} steps`]}>
            <Dial progress={null} big={String(plan.steps.length)} small="steps, by themselves" />
          </Plate>
        );
        below = <RunList plan={plan} run={run} elapsed={0} />;
      }
      links.push(planLink(plan));
      break;
    }
    case "elevating":
      title = "Waiting for Windows";
      line = continuesRemoval(s.plan, read)
        ? "Windows asks once more for permission, to take Lanterel OS off the disk. Click Yes."
        : "Windows asks for permission to make changes. Click Yes.";
      extra = (
        <p className="mstatus mlive">
          <i className="mpulse" aria-hidden="true" />
          No prompt? Look for a flashing shield on the taskbar and click it.
        </p>
      );
      plate = s.plan.mok ? (
        <CodePlate code={s.plan.mok.code} caption={["Your key code", "Write it down"]} />
      ) : (
        <Plate caption={["Windows", "Asking now"]}>
          <Dial live progress={null} big={mmss(elapsed)} small="waiting" />
        </Plate>
      );
      below = <Strip tiles={WINDOWS_ASKS.slice(1)} label="When Windows asks" />;
      break;
    case "running": {
      const { plan, step, index } = s;
      const bytes = run.progress?.id === step.id ? run.progress : null;
      const left = bytes ? timeLeft(run.meter, bytes.total) : null;
      const hint = hintOf(step.id);
      title = runningTitleOf(plan, step) ?? step.title;
      line = `${bytes ? (left ?? "") : hint.line} Keep the PC on. You can leave this screen open.`.trim();
      extra = (
        <p className="mstatus mlive">
          <i className="mpulse" aria-hidden="true" />
          Step {index + 1} of {plan.steps.length}, running for {mmss(elapsed)}
        </p>
      );
      const percent = bytes ? Math.floor((bytes.done / bytes.total) * 100) : 0;
      plate = bytes ? (
        <Plate caption={[`${percent} percent`, left ? left.replace(/\.$/, "") : "Measuring"]}>
          <Dial
            live
            progress={bytes.done / bytes.total}
            big={bytes.pass.name}
            small={passBytes(bytes.pass)}
          />
        </Plate>
      ) : (
        <Plate caption={[`Step ${index + 1} of ${plan.steps.length}`, hint.short]}>
          <Dial live progress={index / plan.steps.length} big={mmss(elapsed)} small="this step" />
        </Plate>
      );
      below = <RunList plan={plan} run={run} elapsed={elapsed} />;
      break;
    }
    case "restart": {
      const remove = removesKey(s.plan) || s.removing === "key";
      const check = s.removing === "check";
      const once = s.plan?.kind === "once";
      title = once
        ? "Restart into Lanterel OS"
        : check
          ? "Restart to check Windows"
          : remove
            ? "Restart to remove the key"
            : "Restart to confirm the key";
      line = once
        ? "Lanterel OS starts on the next restart only. Then Windows again."
        : check
          ? "Lanterel OS is off this PC. Restart once, then open Lanterel: it checks Windows started as usual."
          : "Have your code at hand. The PC restarts to a blue screen, and this app closes.";
      if (!once && !check)
        extra = (
          <p className="mwarn">
            On the blue screen, choose {remove ? "Delete" : "Enroll"} MOK. Never Continue boot.
          </p>
        );
      action = (
        <Pill icon="refresh" onClick={actions.restartRental}>
          Restart now
        </Pill>
      );
      plate = s.code ? (
        <CodePlate code={s.code} caption={["Your key code", "Type it on the blue screen"]} />
      ) : (
        <ReadyPlate small="to restart" />
      );
      if (!once && !check)
        below = (
          <Strip tiles={blueScreen(remove)} label="After the restart, on the blue screen">
            <NoContinue />
          </Strip>
        );
      if (s.plan) links.push(planLink(s.plan));
      break;
    }
    case "restarting":
      title = "Restarting";
      line = s.code ? "Have your code ready." : "The PC restarts in a few seconds.";
      extra = (
        <p className="mstatus mlive">
          <i className="mpulse" aria-hidden="true" />
          {s.plan
            ? `Step ${s.plan.steps.length} of ${s.plan.steps.length}, running for ${mmss(elapsed)}`
            : `Restarting for ${mmss(elapsed)}`}
        </p>
      );
      plate = s.code ? (
        <CodePlate code={s.code} caption={["Your key code", "Type it on the blue screen"]} />
      ) : (
        <Plate caption={["This PC", "Restarting"]}>
          <Dial live progress={null} big={mmss(elapsed)} small="restarting" />
        </Plate>
      );
      if (s.plan) below = <RunList plan={s.plan} run={run} elapsed={elapsed} restarting />;
      break;
    case "failed": {
      const f = failureOf(setup, s);
      title = f.title;
      line = f.why;
      const sent = run.reportedAt !== null;
      extra = (
        <>
          <Changed>{f.changed}</Changed>
          {sent ? <Sent at={run.reportedAt!} /> : null}
        </>
      );
      const other =
        f.kind === "space"
          ? otherRoom(read, s.plan.target?.kind === "shrink" ? s.plan.target.letter : "C")
          : null;
      const onAction = () => {
        if (f.action === "send") return actions.reportRental();
        if (f.action === "use" && other) {
          actions.chooseRentalTarget(other.id);
          return actions.closeRentalPreview();
        }
        if (f.action === "check") {
          actions.closeRentalPreview();
          return actions.checkRental();
        }
        actions.retryRental();
      };
      action = (
        <Pill
          icon={f.action === "use" ? "arrow" : f.action === "send" ? "arrow" : "refresh"}
          onClick={onAction}
        >
          {f.label}
        </Pill>
      );
      if (f.kind === "admin")
        plate = (
          <Plate caption={[f.what, f.at]}>
            <Dial progress={null} big="Waiting" small="for permission" />
          </Plate>
        );
      else if (f.kind === "bios" && f.bios)
        plate = (
          <SettingsPlate
            where={f.what}
            rows={[{ name: BIOS_ASKS[f.bios].setting, value: BIOS_ASKS[f.bios].value }]}
            checking={reading}
            at={f.at.replace(/^Checked at /, "")}
          />
        );
      else if (f.kind === "space" && read)
        plate = (
          <SettingsPlate
            where="Space"
            label={`Free now, Lanterel OS needs ${gb(read.need)}`}
            rows={read.facts.volumes
              .filter((v) => v.fixed && v.fs.toUpperCase() === "NTFS")
              .map((v) => ({ name: `${v.letter}:`, value: gb(v.free), wait: v.free < read.need }))}
            checking={false}
            at={f.at.replace(/^Checked at /, "")}
          />
        );
      else
        plate = (
          <Plate caption={[f.what, f.at]}>
            <Dial off cut big="Stopped" small={f.far} />
          </Plate>
        );
      if (f.kind === "admin") below = <Strip tiles={WINDOWS_ASKS} label="When Windows asks" />;
      if (f.kind === "bios" && f.bios) below = <Strip tiles={biosTrip([f.bios], read)} label="In the BIOS" />;
      if (continuesRemoval(s.plan, read)) links.push(rekeyLink(actions));
      if (s.error)
        links.push({
          id: "why",
          label: "What happened, in detail",
          body: (
            <Detail error={s.error} sent={sent} onSend={f.action === "send" ? null : actions.reportRental} />
          ),
        });
      break;
    }
    case "nokey":
      title = "The key didn't go in";
      line =
        "Windows started straight from the blue screen, without Lanterel's key. Confirm it again, with a new code.";
      extra = (
        <Changed>
          Lanterel OS is installed and Windows works as before. Windows may ask you to set your PIN again, now
          and once after the next restart. Keep your Microsoft account password ready.
        </Changed>
      );
      action = (
        <Pill icon="refresh" onClick={() => actions.previewRental("mok")}>
          Confirm the key
        </Pill>
      );
      plate = <ScreenPlate text={"Perform MOK management\n  Continue boot\n> Enroll MOK"} />;
      below = (
        <Strip tiles={blueScreen()} label="After the restart, on the blue screen">
          <NoContinue />
        </Strip>
      );
      break;
    case "ask":
      title = "Did the blue screen take your code?";
      line =
        "Windows can't see the blue screen, so Lanterel asks. If you chose Enroll MOK, typed the code and chose Reboot, it did.";
      action = (
        <>
          <Pill icon="check" onClick={() => actions.answerRentalKey(true)}>
            Yes, it did
          </Pill>
          <button type="button" className="lnk" onClick={() => actions.answerRentalKey(false)}>
            No, or I'm not sure
          </button>
        </>
      );
      plate = <ScreenPlate text={"Perform MOK management\n> Reboot"} />;
      below = <Strip tiles={blueScreen()} label="What the blue screen asked for" />;
      break;
    case "key":
      title = "Confirm Lanterel's key";
      line =
        "Lanterel OS is installed, but its key wasn't confirmed, so rental mode can't start yet. The PC restarts once more, with a new code.";
      action = (
        <Pill icon="refresh" onClick={() => actions.previewRental("mok")}>
          Confirm the key
        </Pill>
      );
      plate = <ScreenPlate text={"Perform MOK management\n  Continue boot\n> Enroll MOK"} />;
      below = (
        <Strip tiles={blueScreen()} label="After the restart, on the blue screen">
          <NoContinue />
        </Strip>
      );
      links.push({
        id: "remove",
        label: "Remove Lanterel OS",
        onClick: () => actions.previewRental("remove"),
      });
      break;
    case "back": {
      const { live } = s;
      title = `You were live ${clock(live.from)} to ${clock(live.to)}`;
      const ran = live.sessions - live.early;
      line =
        live.sessions === 0
          ? "No one booked it this time. Lanterel OS is waiting for the next time you go live."
          : `${live.sessions === 1 ? "1 session" : `${live.sessions} sessions`}, ${
              live.early === 0
                ? live.sessions === 1
                  ? "it ran to its end"
                  : live.sessions === 2
                    ? "both ran to their end"
                    : "all ran to their end"
                : `${ran} ran to ${ran === 1 ? "its" : "their"} end and ${live.early} ended early`
            }. Lanterel OS is waiting for the next time you go live.`;
      action = (
        <Pill
          icon="arrow"
          onClick={() => {
            actions.seenLastLive();
            go("live");
          }}
        >
          Go live again
        </Pill>
      );
      plate = (
        <Plate caption={["Tonight", live.sessions === 1 ? "1 session" : `${live.sessions} sessions`]}>
          <Dial
            progress={1}
            big={live.earned === null ? String(live.sessions) : <Eur n={live.earned} />}
            small={live.earned === null ? "sessions" : "earned tonight"}
          />
        </Plate>
      );
      break;
    }
    case "installed":
      title = "Rental mode is ready";
      line =
        "When you go live, the PC restarts into Lanterel OS and players can book it. When you stop, it goes back to Windows.";
      action = (
        <Pill icon="arrow" onClick={() => go("live")}>
          Go live
        </Pill>
      );
      plate = <ReadyPlate small="for rental mode" />;
      links.push({
        id: "remove",
        label: "Remove Lanterel OS",
        onClick: () => actions.previewRental("remove"),
      });
      break;
  }

  // The checks stay one link away until the PC is ready, and while a to-do or a stop needs them.
  if (read && at < 2 && !["running", "elevating", "restarting", "failed"].includes(s.kind))
    links.push(checkedLink(read, target));
  if (s.kind === "bios")
    links.push({ id: "sb", label: "Secure Boot won't turn on?", body: <SecureBootHelp /> });

  // A plan was asked for: main reads the PC again first, which can take a while. Its action waits,
  // and the screen says so, rather than look as if the press did nothing.
  if (setup.planning && !setup.preview)
    action = (
      <p className="mstatus mlive" role="status">
        <i className="mpulse" aria-hidden="true" />
        Getting it ready. This can take up to a minute.
      </p>
    );

  return (
    <main className="step">
      <section className="hz">
        <div className="cp">
          <p className="mono ctx">{label}</p>
          <h1>{title}</h1>
          {line ? <p className="ln">{line}</p> : null}
          {extra}
          {action ? <div className="acts">{action}</div> : null}
        </div>
        {plate}
      </section>
      {below}
      <Links items={links} />
      <i className="ruler" aria-hidden="true" />
    </main>
  );
}

/** For the step's running title elsewhere (the Go live screen): what the step is called now. */
export const runningTitle = (step: PlanStep): string => RUNNING_TITLE[step.id] ?? step.title;
