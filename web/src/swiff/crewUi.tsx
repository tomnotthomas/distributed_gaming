// The pieces the crew page and the crew link's invite share, in the approved
// lobby look (crew.css): the key art fading into paper, the drafted title, the
// progress stops, a member's avatar, and sharing a message.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { initials } from "./Chrome";
import { crewText, langOf, type CopyKey, type Lang } from "./crewCopy";
import type { CrewView } from "./crews";
import { GAMES } from "./data";
import { shareTarget, type Channel } from "./invite";
import { gameArt } from "./steam";

/** The lobby's key art: Counter-Strike 2's, free to play, so nobody is shown a game they cannot have. */
const ART = GAMES.find((g) => g.id === "cs")!;

/** The words for the crew screens in the browser's language, and that language. */
export function useCrewText(): { lang: Lang; t: ReturnType<typeof crewText> } {
  return useMemo(() => {
    const lang = langOf();
    return { lang, t: crewText(lang) };
  }, []);
}

/** The tick the checklist and the progress stops draw. */
export function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A gaming PC, drawn as the lobby's PC slot draws it. */
export function PcIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="3" width="10" height="18" rx="1.5" />
      <circle cx="12" cy="9" r="2.2" />
      <circle cx="12" cy="15.5" r="2.2" />
    </svg>
  );
}

/** The key art as a plain image, for the PC card and the link preview. */
export function LobbyArtImage() {
  return <img src={gameArt(ART, 2)} alt="" />;
}

/** The key art, fading into the paper the lobby sits on. */
export function LobbyArt() {
  return (
    <div className="lb-art" aria-hidden="true">
      <LobbyArtImage />
    </div>
  );
}

/** The drafted title: dimension lines over it, the lime mark under it. */
export function LobbyTitle({ children, prose = false }: { children: ReactNode; prose?: boolean }) {
  return (
    <div className="lb-title">
      <span className="dim" aria-hidden="true" />
      <h1 id="lb-h1" className={prose ? "lb-prose" : undefined}>
        {children}
      </h1>
      <span className="mark" aria-hidden="true" />
    </div>
  );
}

/** Someone's avatar: their initials in a coloured circle, picked by where they stand in the crew. */
export function Avatar({ name, index, empty }: { name: string | null; index: number; empty?: string }) {
  const tone = ["l", "o", "b"][index % 3];
  if (empty)
    return (
      <span className="av e" aria-hidden="true">
        {empty}
      </span>
    );
  return (
    <span className={`av ${tone}`} aria-hidden="true">
      {name ? initials(name) : "?"}
    </span>
  );
}

/** How far the crew is: started, people in, a gaming PC in, ready to play. */
export function ProgressStops({
  crew,
  label,
}: {
  crew: Pick<CrewView, "size" | "pcs" | "state">;
  label: string;
}) {
  const { t } = useCrewText();
  const steps: [CopyKey, boolean][] = [
    ["cp.stepMade", true],
    ["cp.stepPeople", crew.size > 1],
    ["cp.stepPc", crew.pcs > 0],
    ["cp.stepReady", crew.state === "ready"],
  ];
  const now = steps.findIndex(([, done]) => !done);
  return (
    <ol className="lb-prog" aria-label={label}>
      {steps.map(([key, done], i) => (
        <li
          key={key}
          className={done ? "done" : i === now ? "now" : undefined}
          aria-current={i === now ? "step" : undefined}
        >
          <span className="dot">
            <Tick />
          </span>
          <span className="lbl">{t(key)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Put `text` on the clipboard; false when the browser will not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The app a copied message is pasted into, by its channel. */
const APP: Record<"discord" | "signal", string> = { discord: "Discord", signal: "Signal" };

/**
 * Sharing a message with a link: WhatsApp through the phone's own share sheet
 * where the browser has one, else wa.me; the other channels as shareTarget
 * says. `note` is the line the page shows after, `onShared` hears which way it
 * went, never the message: the link in it is the whole credential for joining.
 */
export function useShare(onShared?: (channel: Channel) => void) {
  const { t } = useCrewText();
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const say = (text: string | null) => {
    clearTimeout(timer.current);
    setNote(text);
    if (text) timer.current = setTimeout(() => setNote(null), 6000);
  };

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  /** Share by `channel`; resolves true once it went (or was handed to the app that sends it). */
  const share = async (channel: Channel, message: string, link: string, done?: CopyKey): Promise<boolean> => {
    if (channel === "share" || (channel === "whatsapp" && canShare)) {
      try {
        await navigator.share({ text: message });
        onShared?.(channel === "share" ? "share" : "whatsapp");
        say(done ? t(done) : null);
        return true;
      } catch (error) {
        // Dismissed: nothing went. Refused outright: WhatsApp by its link still works.
        if ((error as Error | null)?.name === "AbortError" || channel === "share") return false;
      }
    }
    const target = shareTarget(channel, message, link);
    onShared?.(channel);
    if ("open" in target) {
      window.open(target.open, "_blank", "noopener,noreferrer");
      say(done ? t(done) : null);
      return true;
    }
    if (await copyText(target.copy)) {
      say(t("toast.pasted", { app: APP[channel as "discord" | "signal"] }));
      return true;
    }
    say(t("toast.copyFailed"));
    return false;
  };

  /** Copy the link itself. */
  const copyLink = async (link: string) =>
    say(t((await copyText(link)) ? "toast.copied" : "toast.copyFailed"));

  return { note, say, share, copyLink, canShare };
}
