// What an invite page (/crew, /seat, /gift, /night and their /en/ twins, in
// marketing.ts) says in place of the example people marketing built them with
// (Max, Lena, Jonas, Tom, "Toms Rig", Friday 10 October…), per invite.
//
// The product knows little about an invite yet: a crew invite link names its
// crew's owner; seats at a rig, gifted seats and crew Nights do not exist at
// all. So every page says it without anyone's name or facts it does not have,
// and a crew invite whose inviter is known names them in its headlines.
// Nothing here makes up a person.
//
// Each page's copy replaces the text of the elements marked with its data-t
// key, its title and its link-preview tags, and a few literal bits of the
// mock-ups that carry an example name. The names come from people, so they are
// escaped; the copy is the pages' own HTML. A first name is never assumed to
// say whether to write "he" or "she": the copy is written without either.

export type InviteType = "crew" | "seat" | "gift" | "night";
export type Lang = "de" | "en";

/**
 * What the product knows about one invite. Only a crew invite's inviter, for
 * now. TODO: the rig, its graphics card and seat, the dates and the crew
 * members, once seats, gifts and Nights exist; each page below says where.
 */
export type InviteView = {
  /** The inviter's name as the product shows them (a Steam persona); null when unknown. */
  inviter: string | null;
};

export const UNKNOWN_INVITE: InviteView = { inviter: null };

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

/** `s` safe as HTML text, with braces escaped too so a name never turns into a {{token}}. */
const escapeHtml = (s: string) => s.replace(/[&<>"'{}]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A name as it may be shown: trimmed, at most 40 characters; null when nothing is left. */
export function shownName(name: string | null): string | null {
  const trimmed = name?.replace(/\s+/g, " ").trim().slice(0, 40);
  return trimmed ? trimmed : null;
}

/** The copy for an invite of `type` in `lang`. */
export function inviteCopy(type: InviteType, lang: Lang, view: InviteView): InviteCopy {
  const name = shownName(view.inviter);
  switch (type) {
    case "crew":
      return name ? namedCrew(lang, escapeHtml(name)) : crew(lang);
    // TODO: name the host, their rig, graphics card and town, the seat and its
    // last day (rig.f1v to rig.f5v) once a seat at a friend's rig exists.
    case "seat":
      return seat(lang);
    // TODO: name the friend who gave the seat once gifted seats exist.
    case "gift":
      return gift(lang);
    // TODO: name the organiser, the crew members (night.p1 to night.p4), the
    // evening, the PCs and the renter's seat once crew Nights exist.
    case "night":
      return night(lang);
  }
}

// --- crew --------------------------------------------------------------------

/** The mock-up's chat and crew list show the inviter: `who` and an initial in a circle. */
const crewMockup = (who: string, initial: string): [string, string][] => [
  ["<b>Max</b>", `<b>${who}</b>`],
  ['<span class="av m">M</span>', `<span class="av m">${initial}</span>`],
];

/** The crew invite page in `lang`: a friend asks to play on the reader's gaming PC. */
function crew(lang: Lang): InviteCopy {
  if (lang === "de")
    return {
      title: "Jemand aus deiner Crew möchte bei dir zocken",
      ogTitle: "Jemand aus deiner Crew möchte bei dir zocken",
      description:
        "Jemand aus deiner Crew hat jetzt einen Mac und würde gern auf deinem Gaming-PC zocken, wenn du nicht dran sitzt. Mit dem eigenen Steam-Konto, nur für eure Crew.",
      text: {
        "crew.h1": "Jemand aus deiner Crew möchte <b>bei dir zocken.</b>",
        "crew.lead":
          "Auf der einen Seite ein Mac, auf der anderen dein Gaming-PC. Mit {{brand}} zockt deine Crew mit dem eigenen Steam-Konto auf deinem Rechner, immer dann, wenn du nicht dran sitzt. Erst mal nur eure Crew, keine Fremden.",
        "crew.no": "Nee, lieber nicht. Wir geben Bescheid.",
        "crew.acb": "PC für deine Crew freigeben",
        "crew.cap": "Jeder spielt die eigenen Spiele, mit dem eigenen Steam-Konto.",
        "crew.sh": "Was deine Crew auf deinem PC sieht. Und was nicht.",
        "crew.canh": "Sieht deine Crew",
        "crew.can1": "Steam im Vollbild, mit dem eigenen Konto",
        "crew.can2": "die eigenen Spiele",
        "crew.noh": "Sieht deine Crew nicht",
        "crew.fresh": "Ist die Runde vorbei, startet der PC neu, und alles von deinem Gast ist weg.",
        "crew.fh": "Drei Schritte, dann zockt deine Crew bei dir",
        "crew.f3h": "Für deine Crew freigeben",
        "crew.f3p":
          "Brauchst du den PC gerade nicht, gibst du ihn für deine Crew frei. Gezockt wird dann in Chrome auf dem Mac. Willst du selbst ran, gehört der PC wieder dir, sobald die Runde vorbei ist.",
        "crew.note":
          "Zusammen zocken geht auch: du am Steam Deck oder an einem zweiten PC, deine Crew auf deinem Rechner.",
        "crew.watch":
          "Jemand aus deiner Crew sitzt gerade an deinem PC? Frag, ob du zuschauen darfst. Der Bildschirm wird mit der Crew nur geteilt, wenn die Person Ja sagt.",
      },
      literal: crewMockup("Deine Crew", "C"),
    };
  return {
    title: "A friend wants to borrow your rig",
    ogTitle: "A friend wants to borrow your rig",
    description:
      "A friend of yours has a Mac now and would love to play on your gaming PC when you're not using it. On their own Steam account, crew only.",
    text: {
      "crew.h1": "A friend wants to <b>borrow your rig.</b>",
      "crew.lead":
        "They've got a Mac, you've got the gaming PC. With {{brand}}, your friend can play on your machine whenever you're not using it, with their own Steam account. Just your crew to start with, no strangers.",
      "crew.no": "Not for me. We'll let them know.",
      "crew.acb": "Let them on",
      "crew.cap": "Everyone plays their own games, on their own Steam account.",
      "crew.sh": "What your friend gets on your PC, and what's off-limits.",
      "crew.canh": "They get",
      "crew.can1": "Steam in full screen, signed in to their own account",
      "crew.can2": "their own games",
      "crew.fresh": "When they're done, the PC restarts and everything they left behind is gone.",
      "crew.fh": "Three steps and your friend is in",
      "crew.f3h": "Free it up for your friend",
      "crew.f3p":
        "Not using the PC? Let your friend on. They play in Chrome on their Mac. Want it back? It's yours as soon as they're done.",
      "crew.note":
        "Want to play together? You jump on a Steam Deck or a second PC while your friend plays on your rig.",
      "crew.watch":
        "Your friend is on your PC right now? Ask if you can watch. They share their screen with the crew, but only if they say yes.",
    },
    literal: crewMockup("Your friend", "F"),
  };
}

/** The neutral crew copy with the inviter, `n` (escaped), named in its headlines. */
function namedCrew(lang: Lang, n: string): InviteCopy {
  const base = crew(lang);
  const initial = [...n.replace(/&#\d+;/g, "")][0]?.toUpperCase() ?? "?";
  if (lang === "de")
    return {
      title: `${n} möchte bei dir zocken`,
      ogTitle: `${n} möchte bei dir zocken`,
      description: `${n} hat jetzt einen Mac und würde gern auf deinem Gaming-PC zocken, wenn du nicht dran sitzt. Mit dem eigenen Steam-Konto, nur für eure Crew.`,
      text: {
        ...base.text,
        "crew.h1": `${n} möchte <b>bei dir zocken.</b>`,
        "crew.lead": `${n} hat einen Mac, du den Gaming-PC. Mit {{brand}} zockt ${n} mit dem eigenen Steam-Konto auf deinem Rechner, immer dann, wenn du nicht dran sitzt. Erst mal nur eure Crew, keine Fremden.`,
        "crew.no": `Nee, lieber nicht. Wir sagen ${n} Bescheid.`,
        "crew.acb": `PC für ${n} freigeben`,
        "crew.sh": `Was ${n} auf deinem PC sieht. Und was nicht.`,
        "crew.fh": `Drei Schritte, dann zockt ${n} bei dir`,
        "crew.f3h": `Für ${n} freigeben`,
      },
      literal: crewMockup(n, initial),
    };
  return {
    title: `${n} wants to borrow your rig`,
    ogTitle: `${n} wants to borrow your rig`,
    description: `${n} has a Mac now and would love to play on your gaming PC when you're not using it. On their own Steam account, crew only.`,
    text: {
      ...base.text,
      "crew.h1": `${n} wants to <b>borrow your rig.</b>`,
      "crew.lead": `${n} has a Mac, you've got the gaming PC. With {{brand}}, ${n} can play on your machine whenever you're not using it, with their own Steam account. Just your crew to start with, no strangers.`,
      "crew.no": `Not for me. We'll let ${n} know.`,
      "crew.acb": `Let ${n} on`,
      "crew.sh": `What ${n} gets on your PC, and what's off-limits.`,
      "crew.fh": `Three steps and ${n} is in`,
      "crew.f3h": `Free it up for ${n}`,
    },
    literal: crewMockup(n, initial),
  };
}

// --- seat at a friend's rig ------------------------------------------------------

/** The rig seat page in `lang`: a host holds a seat at their rig for the reader. */
function seat(lang: Lang): InviteCopy {
  if (lang === "de")
    return {
      title: "Jemand hält dir einen Platz an einem Rig frei",
      ogTitle: "Jemand hält dir einen Platz an einem Rig frei",
      description:
        "Jemand teilt den eigenen Gaming-PC mit Freunden, und ein Platz ist für dich freigehalten. Deine Steam-Spiele laufen auf diesem Rechner, du zockst auf deinem Mac.",
      text: {
        "rig.h1": "Jemand hält dir einen Platz <b>an einem Rig frei.</b>",
        "rig.lead":
          "Jemand teilt den eigenen Gaming-PC mit Freunden, und einer der Plätze gehört dir. Deine eigenen Steam-Spiele laufen auf diesem Rechner, du zockst auf deinem Mac, direkt in Chrome.",
        "rig.sig": "Freigehalten für dich · 14 Tage",
        "rig.fh": "Das Rig",
        "rig.fn":
          "Auf dem PC läuft {{brand}} OS, ein eigenes System. Dein Steam-Login bleibt dort nicht hängen: Nach dem Zocken ist er weg.",
        "rig.f1v": "für dich freigehalten",
        "rig.f2v": "siehst du nach dem Anmelden",
        "rig.f3v": "siehst du nach dem Anmelden",
        "rig.f4v": "siehst du nach dem Anmelden",
        "rig.f5v": "14 Tage ab der Einladung",
        "rig.hh": "So zockst du an diesem Rig",
        "rig.s2p": "In Chrome auf deinem Mac. Danach siehst du deine Bibliothek und wann das Rig frei ist.",
        "rig.s3p": "Einmal den QR-Code mit der Steam-App scannen, dann läuft das Spiel auf dem Rig.",
      },
      literal: [],
    };
  return {
    title: "A friend saved you a seat at their rig",
    ogTitle: "A friend saved you a seat at their rig",
    description:
      "A friend shares their gaming PC with friends, and one seat is saved for you. Your Steam games run on their machine, you play from your Mac.",
    text: {
      "rig.h1": "A friend saved you a seat <b>at their rig.</b>",
      "rig.lead":
        "A friend shares their gaming PC with friends, and one of the seats is yours. You play your own Steam games on their machine, from your Mac, right in Chrome.",
      "rig.sig": "Saved for you · 14 days",
      "rig.fh": "The rig",
      "rig.fn":
        "The PC runs {{brand}} OS, a separate system. Your Steam login doesn't stick around: it's gone once you're done.",
      "rig.f1v": "saved for you",
      "rig.f2v": "shown once you sign in",
      "rig.f3v": "shown once you sign in",
      "rig.f4v": "shown once you sign in",
      "rig.f5v": "14 days from the invite",
      "rig.hh": "How to play on this rig",
      "rig.s2p": "In Chrome on your Mac. You'll see your library and when the rig is free.",
      "rig.s3p": "Scan the QR code once with the Steam app, and the game starts on the rig.",
    },
    literal: [],
  };
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
    },
    literal: [],
  };
}

// --- crew Night ------------------------------------------------------------------

/** The crew Night page in `lang`: an invitation to play together with the crew. */
function night(lang: Lang): InviteCopy {
  if (lang === "de")
    return {
      title: "Crew-Abend mit deiner Crew",
      ogTitle: "Crew-Abend mit deiner Crew",
      description: "Deine Crew hat einen Crew-Abend organisiert, und ein Platz ist für dich. Bist du dabei?",
      text: {
        "night.h1": "Deine Crew und du: <b>Es wird gezockt.</b>",
        "night.lead":
          "Deine Crew hat einen Crew-Abend organisiert. Ein Gaming-PC steht für dich bereit. Gezockt wird, worauf ihr Bock habt.",
        "night.p1": "Crew · Mac oder Deck",
        "night.p2": "Crew · Gaming-PC",
        "night.p4": "Platz für bis zu 4",
        "night.fn":
          "Wir erinnern dich am Tag des Abends um 19 Uhr per Mail. Sagst du ab, geht dein Platz an den Nächsten in der Crew.",
        "night.f1v": "kommt per Mail",
        "night.f2v": "höchstens 4",
        "night.f3v": "kommt per Mail",
        "night.f4v": "kommt per Mail",
        "night.hh": "Was du für den Abend brauchst",
      },
      literal: [],
    };
  return {
    title: "Crew Night with your crew",
    ogTitle: "Crew Night with your crew",
    description: "Your crew has set up a Crew Night, and one seat is yours. You in?",
    text: {
      "night.h1": "Your crew and you: <b>it's game night.</b>",
      "night.lead":
        "Your crew has set up a Crew Night. A gaming PC is lined up for you. Everyone can play whatever they like.",
      "night.p1": "crew · Mac or Deck",
      "night.p2": "crew · gaming PC",
      "night.p4": "room for up to 4",
      "night.fn":
        "We'll email you a reminder at 7 pm on the day. If you drop out, your seat goes to the next person in the crew.",
      "night.f1v": "sent by email",
      "night.f2v": "4 max",
      "night.f3v": "sent by email",
      "night.f4v": "sent by email",
      "night.hh": "What you need for the night",
    },
    literal: [],
  };
}
