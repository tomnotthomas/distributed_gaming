import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { crewText, langOf, type CopyKey } from "./crewCopy";
import { Glyph } from "./Glyph";
import {
  fetchMyInvite,
  inviteLink,
  removeCrewMember,
  shareTarget,
  type Channel,
  type MyInvite,
} from "./invite";

const CHANNELS = [
  { id: "whatsapp", label: "ask.whatsapp" },
  { id: "discord", label: "ask.discord" },
  { id: "steam", label: "ask.steam" },
  { id: "email", label: "ask.email" },
] as const satisfies readonly { id: Exclude<Channel, "share">; label: CopyKey }[];

const APP: Record<"discord" | "steam", CopyKey> = { discord: "ask.discord", steam: "ask.steam" };

/** Put `text` on the clipboard; false when the browser will not. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The signed-in player's invite link, read once the card is up, and making a new one. */
function useMyInvite() {
  const [invite, setInvite] = useState<MyInvite | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((renew = false) => {
    setBusy(true);
    setFailed(false);
    void fetchMyInvite({ renew }).then((next) => {
      setBusy(false);
      if (next) setInvite(next);
      else setFailed(true);
    });
  }, []);

  useEffect(() => load(), [load]);
  return { invite, failed, busy, load };
}

/**
 * Ask your PC friend: the signed-in player's personal invite link and the ways
 * to send it, the phone's own share sheet first where the browser has one.
 * Whoever opens it lands on the host side with this player named, and their PC
 * hosts this player's crew alone. `onShared` hears which way it was sent,
 * never the link: that is the whole credential for joining. Below it, who is
 * in the crew, each with Remove, and the crews the player joined, each with
 * Leave crew.
 */
export function AskFriend({ persona, onShared }: { persona: string; onShared?: (channel: Channel) => void }) {
  const t = useMemo(() => crewText(langOf()), []);
  const { invite, failed, busy, load } = useMyInvite();
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const link = invite ? inviteLink(invite.token) : "";
  const message = persona ? t("ask.message", { name: persona, link }) : t("ask.messageAnon", { link });
  const subject = t("ask.subject");

  const say = (key: CopyKey, fill?: Record<string, string>) => setNote(t(key, fill));

  const copyLink = async () => {
    if (await copyText(link)) say("ask.copied");
    else {
      field.current?.select();
      say("ask.copyFailed");
    }
  };

  const shareNative = async () => {
    try {
      await navigator.share({ title: subject, text: message });
      onShared?.("share");
    } catch {
      // Dismissed, or the browser refused: the other ways are still there.
    }
  };

  const shareTo = async (channel: Exclude<Channel, "share">) => {
    const target = shareTarget(channel, message, subject);
    onShared?.(channel);
    if ("open" in target) {
      window.open(target.open, "_blank", "noopener,noreferrer");
      return;
    }
    if (await copyText(target.copy)) say("ask.pasteIn", { app: t(APP[channel as "discord" | "steam"]) });
    else {
      field.current?.select();
      say("ask.copyFailed");
    }
  };

  const [ending, setEnding] = useState(false);
  const end = async (id: string) => {
    setEnding(true);
    setNote(null);
    const done = await removeCrewMember(id);
    setEnding(false);
    if (done) load();
    else say("ask.removeFailed");
  };

  const size = invite?.crew.size ?? 1;

  return (
    <section className="ask" aria-labelledby="ask-title" data-testid="ask-friend">
      <div className="ask-head">
        <h2 id="ask-title" className="ask-title">
          {t("ask.title")}
        </h2>
        <p className="ask-line">{t("ask.line")}</p>
      </div>

      {invite ? (
        <>
          <div className="ask-link">
            <label className="mono" htmlFor="ask-link">
              {t("ask.linkLabel")}
            </label>
            <div className="ask-field">
              <input
                id="ask-link"
                ref={field}
                readOnly
                value={link}
                spellCheck={false}
                onFocus={(event) => event.target.select()}
              />
              <button type="button" className="lpill lpill-sm" onClick={() => void copyLink()}>
                {t("ask.copy")}
              </button>
            </div>
          </div>

          <div className="ask-ways">
            {canShare ? (
              <button type="button" className="lpill lpill-sm" onClick={() => void shareNative()}>
                {t("ask.share")}
                <span className="lpill-c">
                  <Glyph name="arrow" size={16} />
                </span>
              </button>
            ) : null}
            {CHANNELS.map((c) => (
              <button key={c.id} type="button" className="lpill lpill-sm" onClick={() => void shareTo(c.id)}>
                {t(c.label)}
              </button>
            ))}
          </div>

          <p className="ask-note" role="status">
            {note}
          </p>

          <div className="ask-foot">
            <span className="mono">{size > 1 ? t("ask.crew", { n: size }) : t("ask.crewSolo")}</span>
            <button
              type="button"
              className="share-link ask-renew"
              disabled={busy}
              aria-describedby="ask-renew-hint"
              onClick={() => {
                setNote(null);
                load(true);
              }}
            >
              {t("ask.renew")}
            </button>
            <span id="ask-renew-hint" className="ask-hint">
              {t("ask.renewHint")}
            </span>
          </div>

          {invite.members.length ? (
            <div className="ask-crew">
              <h3 className="mono">{t("ask.members")}</h3>
              <ul className="ask-members">
                {invite.members.map((m) => {
                  const name = m.name || t("ask.memberAnon");
                  return (
                    <li key={m.id}>
                      <span>{name}</span>
                      <button
                        type="button"
                        className="share-link"
                        disabled={busy || ending}
                        aria-label={t("ask.removeLabel", { name })}
                        onClick={() => void end(m.id)}
                      >
                        {t("ask.remove")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {invite.joined.length ? (
            <div className="ask-crew">
              <h3 className="mono">{t("ask.joinedTitle")}</h3>
              <ul className="ask-members">
                {invite.joined.map((c) => {
                  const crew = c.name ? t("ask.joinedCrew", { name: c.name }) : t("ask.joinedCrewAnon");
                  return (
                    <li key={c.id}>
                      <span>{crew}</span>
                      <button
                        type="button"
                        className="share-link"
                        disabled={busy || ending}
                        aria-label={t("ask.leaveLabel", { crew })}
                        onClick={() => void end(c.id)}
                      >
                        {t("ask.leave")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      ) : failed ? (
        <div className="ask-ways" role="alert">
          <span className="ask-line">{t("ask.failed")}</span>
          <button type="button" className="lpill lpill-sm" onClick={() => load()}>
            {t("ask.retry")}
          </button>
        </div>
      ) : (
        <div className="ask-skeleton" aria-busy="true">
          <span className="sr-only">{t("ask.loading")}</span>
        </div>
      )}
    </section>
  );
}

/**
 * The wall's nudge after sign-in: one line and the way to the card, until the
 * player says not now. Remembered in this browser only.
 */
export function AskFriendStrip({ onOpen }: { onOpen: () => void }) {
  const t = useMemo(() => crewText(langOf()), []);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STRIP_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(STRIP_KEY, "1");
    } catch {
      // Blocked storage: it is back on the next load, which is harmless.
    }
  };

  return (
    <div className="library-note ask-strip" data-testid="ask-strip">
      <p>{t("ask.strip")}</p>
      <button type="button" className="lpill lpill-sm" onClick={onOpen}>
        {t("ask.open")}
        <span className="lpill-c">
          <Glyph name="arrow" size={16} />
        </span>
      </button>
      <button type="button" className="share-link ask-later" onClick={dismiss}>
        {t("ask.later")}
      </button>
    </div>
  );
}

const STRIP_KEY = "swiff.askStripDismissed";
