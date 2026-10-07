// What the invite pages the site still renders itself (/gift, /night and
// their /en/ twins, in marketing.ts) say in place of the example people
// marketing built them with (Max, Lena, Tom, Friday 9 October…). A crew link
// and a friend seat are the app's to show (/invite/<token>, /seat/<token>),
// with who asks from the product's own data; gifted seats and Zockrunden do not
// exist yet. So these pages say it without anyone's name or facts the product
// does not have. Nothing here makes up a person.
//
// Each page's copy replaces the text of the elements marked with its data-t
// key, its title and its link-preview tags. The copy is the pages' own HTML.
// A crew link's preview says its crew's Zockrunde, when it has one
// (sessionPreview).

export type InviteType = "crew" | "seat" | "gift" | "night";
/** The invites the site renders itself; the rest are the app's. */
export type SiteInviteType = "gift" | "night";
export type Lang = "de" | "en";

/** One page's copy for one invite. HTML except `title` and the meta tags, which are text. */
export type InviteCopy = {
  title: string;
  description: string;
  ogTitle: string;
  /** Inner HTML by data-t key. */
  text: Record<string, string>;
  /** Exact strings in the page, each replaced wherever it appears. */
  literal: [string, string][];
};

/** The copy for an invite of `type` in `lang`. */
export function inviteCopy(type: SiteInviteType, lang: Lang): InviteCopy {
  // TODO: name the friend who gave the seat once gifted seats exist; the
  // organiser, the crew (night.p1 to night.p4), the day, the PCs and the
  // reader's seat once Zockrunden exist.
  return type === "gift" ? gift(lang) : night(lang);
}

// --- gift seat -------------------------------------------------------------------

/** The gift seat page in `lang`: a friend gives the reader a seat after a good session. */
function gift(lang: Lang): InviteCopy {
  if (lang === "de")
    return {
      title: "Jemand schenkt dir einen Platz",
      ogTitle: "Jemand schenkt dir einen Platz",
      description:
        "Jemand hat gerade über {{brand}} gezockt und dir einen Platz geschenkt: deine Steam-Spiele auf deinem Mac, ohne Warteliste.",
      text: {
        "gift.h1": "Jemand schenkt dir <b>einen Platz.</b>",
        "gift.lead":
          "Gerade wurde über {{brand}} gezockt, gestreamt von einem Gaming-PC in Deutschland. Jetzt bist du dran: deine eigenen Steam-Spiele, auf deinem Mac, direkt in Chrome.",
        "gift.lead2":
          "In der Beta kostet {{brand}} eh nichts. Mit dem geschenkten Platz musst du aber nicht auf die nächste Einladungswelle warten.",
        "gift.sig": "Geschenkt für dich · gültig 14 Tage",
        "gift.s1p": "Mit Steam anmelden. Kein Passwort, kein neues Konto.",
      },
      literal: [],
    };
  return {
    title: "A friend just got you a seat",
    ogTitle: "A friend just got you a seat",
    description:
      "A friend just played on {{brand}} and got you a seat: your Steam games on your Mac, no waitlist.",
    text: {
      "gift.h1": "A friend just got you <b>a seat.</b>",
      "gift.lead":
        "A friend just played on their Mac, streamed from a gaming PC in Germany. Now it's your turn: your own Steam games, on your Mac, right in Chrome.",
      "gift.lead2":
        "{{brand}} is free during the beta anyway. This seat just lets you skip the wait for the next wave of invites.",
      "gift.sig": "A gift for you · valid for 14 days",
      "gift.s1p": "Sign in with Steam. No password, no new account.",
    },
    literal: [],
  };
}

// --- Zockrunde (the night page) ------------------------------------------------

/** The Zockrunde page in `lang`: an invitation to play together with the crew. */
function night(lang: Lang): InviteCopy {
  if (lang === "de")
    return {
      title: "Zockrunde mit deiner Crew",
      ogTitle: "Zockrunde mit deiner Crew",
      description: "Deine Crew hat eine Zockrunde organisiert, und ein Platz ist für dich. Bist du dabei?",
      text: {
        "night.h1": "Deine Crew und du: <b>Es wird gezockt.</b>",
        "night.lead":
          "Deine Crew hat eine Zockrunde organisiert. Ein Gaming-PC steht für dich bereit. Gezockt wird, worauf ihr Bock habt.",
        "night.p1": "Crew · Mac oder Deck",
        "night.p2": "Crew · Gaming-PC",
        "night.p4": "Platz für bis zu 4",
        "night.fn": "Sagst du ab, geht dein Platz an den Nächsten in der Crew.",
        "night.f1v": "kommt per WhatsApp",
        "night.f2v": "höchstens 4",
        "night.f3v": "kommt per WhatsApp",
        "night.f4v": "kommt per WhatsApp",
        "night.hh": "Was du für die Zockrunde brauchst",
      },
      literal: [],
    };
  return {
    title: "A gaming session with your crew",
    ogTitle: "A gaming session with your crew",
    description: "Your crew has set up a gaming session, and one seat is yours. You in?",
    text: {
      "night.h1": "Your crew and you: <b>time to play.</b>",
      "night.lead":
        "Your crew has set up a gaming session. A gaming PC is lined up for you. Everyone can play whatever they like.",
      "night.p1": "crew · Mac or Deck",
      "night.p2": "crew · gaming PC",
      "night.p4": "room for up to 4",
      "night.fn": "If you drop out, your seat goes to the next person in the crew.",
      "night.f1v": "sent on WhatsApp",
      "night.f2v": "4 max",
      "night.f3v": "sent on WhatsApp",
      "night.f4v": "sent on WhatsApp",
      "night.hh": "What you need for the session",
    },
    literal: [],
  };
}

// --- a crew link's Zockrunde -----------------------------------------------------

/** Where the crews are: a Zockrunde's time is said in German time, the launch's. */
const SESSION_ZONE = "Europe/Berlin";

/**
 * When a Zockrunde starts (`at`, Unix ms), as a crew's invite says it:
 * "Freitag, 9. Oktober, 21 Uhr" or "Friday 9 October, 9 pm", a time off the
 * hour with its minutes ("21:30 Uhr", "9:30 pm").
 */
export function sessionWhen(lang: Lang, at: number): string {
  const day = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: SESSION_ZONE,
  }).format(at);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: SESSION_ZONE,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = parts.find((p) => p.type === "minute")!.value;
  if (lang === "de") return `${day}, ${minute === "00" ? hour : `${hour}:${minute}`} Uhr`;
  const twelve = hour % 12 || 12;
  return `${day}, ${minute === "00" ? twelve : `${twelve}:${minute}`} ${hour < 12 ? "am" : "pm"}`;
}

/** What a crew link's preview says while its crew has a Zockrunde: when, and that the reader answers. */
export function sessionPreview(lang: Lang, at: number): string {
  return lang === "de"
    ? `Zockrunde am ${sessionWhen(lang, at)}. Tipp drauf und sag zu oder ab.`
    : `Session on ${sessionWhen(lang, at)}. Tap to say yes or no.`;
}
