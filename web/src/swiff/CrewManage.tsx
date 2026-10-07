// Who decides who is in a crew, and where a gaming PC plays
// (data/lanterel-design-round, g-remove impeccable): the crew's founder
// removes someone from the "…" next to their name, always after a
// confirmation ticket; a PC's owner takes their PC out of one of the crews it
// plays for without leaving it, also after a confirmation. The server checks
// the same: only the crew's admin removes anyone (server/src/platform.ts,
// leaveCrew), and only an owner takes their own PCs out (bringPc).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { initials } from "./Chrome";
import { useCrewText } from "./crewUi";
import {
  activeSession,
  bringPc,
  crewTitle,
  fetchCrew,
  fetchCrews,
  pcTitle,
  removeCrewMember,
  sessionDay,
  sessionTime,
  type CrewDetail,
  type CrewMember,
} from "./crews";
import { manageText } from "./manageCopy";
import { PhIcon } from "./PhIcon";

/** The founder's "…" next to someone in the crew: remove them, after a confirmation. */
export function MemberMenu({
  crew,
  member,
  onRemoved,
  say,
}: {
  crew: CrewDetail;
  member: CrewMember;
  onRemoved: (memberId: string) => void;
  say: (text: string) => void;
}) {
  const { lang } = useCrewText();
  const t = manageText(lang);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = member.name ?? "?";
  const ref = useRef<HTMLSpanElement>(null);
  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const remove = async () => {
    setBusy(true);
    const done = await removeCrewMember(member.id);
    setBusy(false);
    if (!done) return say(t("rm.failed"));
    setAsking(false);
    say(t("rm.done", { name }));
    onRemoved(member.id);
  };
  const theirPc = member.pcs > 0 ? crew.machines.find((m) => m.owner === member.name) : undefined;

  return (
    <span className="cm-more" ref={ref}>
      <button
        type="button"
        className="cm-more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("rm.more", { name })}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <PhIcon name="dots-three" />
      </button>
      {open ? (
        <span className="cm-pop" role="menu">
          <button
            type="button"
            role="menuitem"
            className="danger"
            autoFocus
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            <PhIcon name="user-minus" size={18} />
            <span>{t("rm.remove")}</span>
          </button>
        </span>
      ) : null}
      {asking ? (
        <Confirm
          labelId={`cm-rm-${member.id}`}
          icon={
            <span className="av p cm-av" aria-hidden="true">
              {initials(name)}
            </span>
          }
          title={t("rm.title", { name })}
          lines={[
            ["x", t("rm.gone", { name, crew: crewTitle(lang, crew) })],
            ...(member.pcs > 0
              ? ([["desktop-tower", t("rm.pc", { pc: theirPc ? pcTitle(lang, theirPc) : name })]] as const)
              : []),
            ["link", t("rm.back", { name })],
            ["check", t("rm.quiet", { name })],
          ]}
          keep={t("rm.cancel")}
          go={t("rm.go", { name })}
          goIcon="user-minus"
          busy={busy}
          onKeep={() => setAsking(false)}
          onGo={() => void remove()}
        />
      ) : null}
    </span>
  );
}

/** A crew the owner's PC plays for, with its next Zockrunde. */
type PcCrew = { id: string; title: string; detail: CrewDetail | null };

/**
 * The owner's gaming PC and the crews it plays for, each with "Take it out of
 * this crew" and a confirmation. `crew` is the crew whose page this is;
 * `onChanged` gets it as it is once the PC is out of it.
 */
export function PcCrews({
  crew,
  onChanged,
  say,
}: {
  crew: CrewDetail;
  onChanged: (next: CrewDetail) => void;
  say: (text: string) => void;
}) {
  const { lang } = useCrewText();
  const t = manageText(lang);
  const [others, setOthers] = useState<PcCrew[]>([]);
  const [asking, setAsking] = useState<PcCrew | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = crew.machines.find((m) => m.mine);
  const pcName = mine ? pcTitle(lang, mine) : t("pcs.title");

  // The other crews the PC plays for: those of the owner's crews with a PC of theirs in.
  useEffect(() => {
    let live = true;
    void fetchCrews().then(async (listed) => {
      if (!listed) return;
      const found: PcCrew[] = [];
      for (const c of listed) {
        if (c.id === crew.id || c.pcs === 0) continue;
        const detail = await fetchCrew(c.id);
        if (detail && detail !== "gone" && detail.members.some((m) => m.you && m.pcs > 0)) {
          found.push({ id: c.id, title: crewTitle(lang, detail), detail });
        }
      }
      if (live) setOthers(found);
    });
    return () => {
      live = false;
    };
  }, [crew.id, lang]);

  const rows: PcCrew[] = [{ id: crew.id, title: crewTitle(lang, crew), detail: crew }, ...others];
  const now = Date.now();
  const nextOf = (detail: CrewDetail | null) => {
    const session = detail ? activeSession(detail, now) : null;
    return session
      ? t("pcs.next", { when: `${sessionDay(lang, session.at)}, ${sessionTime(lang, session.at)}` })
      : null;
  };

  const takeOut = async (row: PcCrew) => {
    setBusy(true);
    const next = await bringPc(row.id, "off");
    setBusy(false);
    if (!next) return say(t("rm.failed"));
    setAsking(null);
    say(t("pcs.done", { crew: row.title }));
    if (row.id === crew.id) onChanged(next);
    else setOthers((was) => was.filter((o) => o.id !== row.id));
  };

  const askLines = (row: PcCrew): (readonly [Parameters<typeof PhIcon>[0]["name"], string])[] => {
    const detail = row.detail;
    const session = detail ? activeSession(detail, now) : null;
    const me = detail?.members.find((m) => m.you);
    // The Zockrunde is left without a gaming PC when the owner's are the only ones in.
    const lastPc = detail !== null && me !== undefined && detail.pcs <= me.pcs;
    const keep = rows.filter((r) => r.id !== row.id).map((r) => r.title);
    return [
      ["x", t("pcs.cant", { crew: row.title })],
      ...(session && lastPc
        ? ([["warning", t("pcs.noPc", { day: sessionDay(lang, session.at) })]] as const)
        : []),
      [
        "check",
        keep.length
          ? t(keep.length === 1 ? "pcs.keeps" : "pcs.keepMany", { crews: keep.join(", ") })
          : t("pcs.youStay"),
      ],
    ];
  };

  return (
    <section className="cm-pc" aria-labelledby="cm-pc-h">
      <h2 id="cm-pc-h">{t("pcs.title")}</h2>
      <div className="cm-screen">
        <p className="cm-pc-h">
          <PhIcon name="desktop-tower" size={22} />
          <span>{t("pcs.plays", { pc: pcName })}</span>
        </p>
        <ul className="cm-crews">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                {row.title}
                {nextOf(row.detail) ? <small>{nextOf(row.detail)}</small> : null}
              </span>
              <button type="button" className="cm-out" disabled={busy} onClick={() => setAsking(row)}>
                {t("pcs.out")}
              </button>
            </li>
          ))}
        </ul>
        <p>{t("pcs.strangers")}</p>
      </div>
      <p className="cm-note">
        <PhIcon name="users" size={18} />
        <span>{t("pcs.stay")}</span>
      </p>
      {asking ? (
        <Confirm
          labelId="cm-pc-ask"
          icon={
            <span className="av cm-av cm-av-pc" aria-hidden="true">
              <PhIcon name="desktop-tower" size={22} />
            </span>
          }
          title={t("pcs.ask", { crew: asking.title })}
          lines={askLines(asking)}
          keep={t("pcs.keep")}
          go={t("pcs.go")}
          fine={t("pcs.fine")}
          busy={busy}
          onKeep={() => setAsking(null)}
          onGo={() => void takeOut(asking)}
        />
      ) : null}
    </section>
  );
}

/** The confirmation ticket over a dimmed page: what will happen, then keep or go. */
function Confirm({
  labelId,
  icon,
  title,
  lines,
  keep,
  go,
  goIcon,
  fine,
  busy,
  onKeep,
  onGo,
}: {
  labelId: string;
  icon: ReactNode;
  title: string;
  lines: readonly (readonly [Parameters<typeof PhIcon>[0]["name"], string])[];
  keep: string;
  go: string;
  goIcon?: Parameters<typeof PhIcon>[0]["name"];
  fine?: string;
  busy: boolean;
  onKeep: () => void;
  onGo: () => void;
}) {
  return (
    <div
      className="cm-dim"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onKeyDown={(event) => {
        if (event.key === "Escape") onKeep();
      }}
    >
      <div className="cm-confirm">
        <div className="cm-top">
          {icon}
          <h2 id={labelId}>{title}</h2>
          <ul className="cm-list">
            {lines.map(([icon, line]) => (
              <li key={line}>
                <PhIcon name={icon} size={18} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="cm-bot">
          <div className="cm-acts">
            <button type="button" className="keep" autoFocus onClick={onKeep}>
              {keep}
            </button>
            <button type="button" className="go" disabled={busy} onClick={onGo}>
              {goIcon ? <PhIcon name={goIcon} size={18} /> : null}
              <span>{go}</span>
            </button>
          </div>
          {fine ? <p className="cm-fine">{fine}</p> : null}
        </div>
      </div>
    </div>
  );
}
