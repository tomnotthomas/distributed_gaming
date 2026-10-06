// The words of the crew screens: the Ask your PC friend card and the invite
// page a friend lands on. Placeholders until marketing's texts arrive: they
// replace the strings here, key for key, in German and English. `{name}`,
// `{link}`, `{app}` and `{n}` are filled in where they appear; nothing else
// about the screens needs to change.

export type Lang = "en" | "de";

export const CREW_COPY = {
  en: {
    "ask.title": "Ask your PC friend",
    "ask.line":
      "Know someone with a gaming PC? Send them your link. Their PC then hosts your crew, and nobody else.",
    "ask.strip": "Got a friend with a gaming PC? Ask them to host your crew.",
    "ask.open": "Ask your PC friend",
    "ask.later": "Not now",
    "ask.linkLabel": "Your invite link",
    "ask.copy": "Copy link",
    "ask.copied": "Link copied",
    "ask.share": "Share",
    "ask.whatsapp": "WhatsApp",
    "ask.discord": "Discord",
    "ask.steam": "Steam chat",
    "ask.email": "Email",
    "ask.pasteIn": "Message copied. Paste it in {app}.",
    "ask.copyFailed": "Could not copy. Select the link and copy it yourself.",
    "ask.crew": "{n} in your crew",
    "ask.crewSolo": "Just you so far",
    "ask.renew": "Make a new link",
    "ask.renewHint": "Your current link stops working.",
    "ask.loading": "Getting your link…",
    "ask.failed": "Your link could not be loaded.",
    "ask.retry": "Try again",
    "ask.message":
      "{name} wants to play on your gaming PC with Swiff. It only ever hosts your crew. Set it up here: {link}",
    "ask.messageAnon":
      "Play with me on your gaming PC with Swiff. It only ever hosts your crew. Set it up here: {link}",
    "ask.subject": "Host our games on your PC?",

    "invite.kicker": "Invited by {name}",
    "invite.kickerAnon": "You're invited",
    "invite.title": "Host {name}'s crew",
    "invite.titleAnon": "Host your friend's crew",
    "invite.line":
      "Your gaming PC plays for your crew while you're away from it. Only people in the crew can ever use it.",
    "invite.signIn": "Then join the crew in one step.",
    "invite.join": "Join the crew",
    "invite.joining": "Joining…",
    "invite.joinFailed": "Joining did not work. Try again.",
    "invite.joined": "You're in {name}'s crew. Your PC will host the crew only.",
    "invite.member": "You're already in {name}'s crew.",
    "invite.joinedAnon": "You're in the crew. Your PC will host the crew only.",
    "invite.memberAnon": "You're already in this crew.",
    "invite.own": "This is your own link. Send it to a friend with a gaming PC.",
    "invite.backToWall": "Back to the wall",
    "invite.invalid": "This invite link does not work any more.",
    "invite.invalidLine": "Ask your friend for their new link.",
    "invite.loading": "Opening the invite…",
    "invite.unanswered": "The invite could not be opened.",
    "invite.retry": "Try again",
    "invite.download": "Download for Windows",
    "invite.soon": "Coming soon",
    "invite.note":
      "Open it on the PC you want to share. The app reads your hardware and takes you through the rest.",
    "invite.crewOnly": "Only your crew",
    "invite.crewOnlyLine": "Nobody outside {name}'s crew is ever matched to your PC.",
    "invite.crewOnlyLineAnon": "Nobody outside the crew is ever matched to your PC.",
    "invite.away": "Only while you're away",
    "invite.awayLine": "Sharing stops the moment you touch the keyboard.",
    "invite.sandbox": "Sandboxed sessions",
    "invite.sandboxLine": "Players get an isolated account with no access to your files or logins.",
    "invite.steps": "How it works",
    "invite.stepJoin": "Join the crew",
    "invite.stepJoinWhere": "Here, with Steam",
    "invite.stepDownload": "Download",
    "invite.stepDownloadWhere": "The button above",
    "invite.stepLive": "Set up and go live",
    "invite.stepLiveWhere": "In the app on your PC",
    "invite.crewSize": "{n} in the crew",
    "invite.inCrew": "in the crew",
  },
  de: {
    "ask.title": "Frag deinen PC-Freund",
    "ask.line":
      "Kennst du jemanden mit Gaming-PC? Schick ihm deinen Link. Sein PC hostet dann deine Crew und sonst niemanden.",
    "ask.strip": "Ein Freund hat einen Gaming-PC? Frag ihn, ob er deine Crew hostet.",
    "ask.open": "PC-Freund fragen",
    "ask.later": "Später",
    "ask.linkLabel": "Dein Einladungslink",
    "ask.copy": "Link kopieren",
    "ask.copied": "Link kopiert",
    "ask.share": "Teilen",
    "ask.whatsapp": "WhatsApp",
    "ask.discord": "Discord",
    "ask.steam": "Steam-Chat",
    "ask.email": "E-Mail",
    "ask.pasteIn": "Nachricht kopiert. Füge sie in {app} ein.",
    "ask.copyFailed": "Kopieren ging nicht. Markiere den Link und kopiere ihn selbst.",
    "ask.crew": "{n} in deiner Crew",
    "ask.crewSolo": "Bisher nur du",
    "ask.renew": "Neuen Link erstellen",
    "ask.renewHint": "Dein bisheriger Link funktioniert dann nicht mehr.",
    "ask.loading": "Dein Link wird geladen…",
    "ask.failed": "Dein Link konnte nicht geladen werden.",
    "ask.retry": "Nochmal versuchen",
    "ask.message":
      "{name} will mit Swiff auf deinem Gaming-PC spielen. Er hostet immer nur eure Crew. Hier einrichten: {link}",
    "ask.messageAnon":
      "Spiel mit mir über Swiff auf deinem Gaming-PC. Er hostet immer nur eure Crew. Hier einrichten: {link}",
    "ask.subject": "Hostest du unsere Spiele auf deinem PC?",

    "invite.kicker": "Eingeladen von {name}",
    "invite.kickerAnon": "Du bist eingeladen",
    "invite.title": "Hoste die Crew von {name}",
    "invite.titleAnon": "Hoste die Crew deines Freundes",
    "invite.line":
      "Dein Gaming-PC spielt für deine Crew, während du nicht daran sitzt. Nur Leute aus der Crew können ihn je nutzen.",
    "invite.signIn": "Danach trittst du der Crew mit einem Klick bei.",
    "invite.join": "Crew beitreten",
    "invite.joining": "Beitreten…",
    "invite.joinFailed": "Beitreten hat nicht geklappt. Versuch es nochmal.",
    "invite.joined": "Du bist in der Crew von {name}. Dein PC hostet nur die Crew.",
    "invite.member": "Du bist schon in der Crew von {name}.",
    "invite.joinedAnon": "Du bist in der Crew. Dein PC hostet nur die Crew.",
    "invite.memberAnon": "Du bist schon in dieser Crew.",
    "invite.own": "Das ist dein eigener Link. Schick ihn einem Freund mit Gaming-PC.",
    "invite.backToWall": "Zurück zur Übersicht",
    "invite.invalid": "Dieser Einladungslink funktioniert nicht mehr.",
    "invite.invalidLine": "Frag deinen Freund nach seinem neuen Link.",
    "invite.loading": "Einladung wird geöffnet…",
    "invite.unanswered": "Die Einladung konnte nicht geöffnet werden.",
    "invite.retry": "Nochmal versuchen",
    "invite.download": "Für Windows laden",
    "invite.soon": "Bald verfügbar",
    "invite.note":
      "Öffne sie auf dem PC, den du teilen willst. Die App liest deine Hardware und führt dich durch den Rest.",
    "invite.crewOnly": "Nur deine Crew",
    "invite.crewOnlyLine": "Niemand außerhalb der Crew von {name} wird je deinem PC zugeteilt.",
    "invite.crewOnlyLineAnon": "Niemand außerhalb der Crew wird je deinem PC zugeteilt.",
    "invite.away": "Nur wenn du weg bist",
    "invite.awayLine": "Das Teilen stoppt, sobald du die Tastatur berührst.",
    "invite.sandbox": "Abgeschottete Sitzungen",
    "invite.sandboxLine": "Spieler bekommen ein eigenes Konto ohne Zugriff auf deine Dateien oder Logins.",
    "invite.steps": "So geht's",
    "invite.stepJoin": "Crew beitreten",
    "invite.stepJoinWhere": "Hier, mit Steam",
    "invite.stepDownload": "Herunterladen",
    "invite.stepDownloadWhere": "Der Button oben",
    "invite.stepLive": "Einrichten und live gehen",
    "invite.stepLiveWhere": "In der App auf deinem PC",
    "invite.crewSize": "{n} in der Crew",
    "invite.inCrew": "in der Crew",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type CopyKey = keyof (typeof CREW_COPY)["en"];

/** German for a browser set to German, English for everyone else. */
export function langOf(languages: readonly string[] = navigator.languages ?? [navigator.language]): Lang {
  return languages.some((l) => /^de\b/i.test(l)) ? "de" : "en";
}

/** The words for `lang`, with each `{slot}` filled from `fill`. */
export function crewText(lang: Lang) {
  return (key: CopyKey, fill: Record<string, string | number> = {}) =>
    (CREW_COPY[lang][key] as string).replace(/\{(\w+)\}/g, (slot, name: string) =>
      Object.hasOwn(fill, name) ? String(fill[name]) : slot,
    );
}
