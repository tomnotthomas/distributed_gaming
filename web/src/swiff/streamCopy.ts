// The words of the full-screen viewer (Viewer.tsx) and of the player's own
// screen once the crew votes on who plays next (SwitchToast), from the
// approved design (data/lanterel-design-round, f-stream impeccable). German
// pages are fully German and English ones fully English, in the crew pages'
// terms (crewCopy.ts): Zockrunde, Gaming-PC, Crew; session, gaming PC, crew.
// `{name}`, `{game}`, `{pc}`, `{n}`, `{of}`, `{time}` and `{player}` are filled in where they appear.

import { fillSlots, possessive, type Lang } from "./crewCopy";

export const STREAM_COPY = {
  en: {
    "w.playing": "{name} is playing {game}",
    "w.someone": "Someone in your crew",
    "w.someoneLower": "someone in your crew",
    "w.theirGame": "their game",
    "w.on": "on {pc}",
    "w.watchingN": "{n} watching",
    "w.stream": "Stream: {game}, played by {name}",
    "w.crew": "Crew",
    "w.leave": "Leave stream",
    "w.soundOn": "Sound on",
    "w.soundOff": "Sound off",
    "w.joinVoice": "Join voice",
    "w.micOn": "Mic on",
    "w.micOff": "Mic off",
    "w.micRefused": "Your browser didn't allow the mic.",
    "w.mutedBy": "{name} muted you.",
    "w.inVoice": "On voice",
    "w.want": "I want to play",

    "m.who": "Who's here",
    "m.back": "Back to the crew page",
    "m.leaveCrew": "Leave the crew",
    "m.nobody": "Nobody is on voice yet.",
    "m.player": "plays",
    "m.muteForMe": "Mute for me",
    "m.hear": "Hear",
    "m.leaveTitle": "Leave the crew?",
    "m.leaveLine": "You stop watching, and the crew link gets you back anytime.",
    "m.leaveYes": "Leave",
    "m.leaveNo": "Stay",
    "m.failed": "That didn't work. Try again.",

    "p.title": "What do you want to play?",
    "p.line": "The crew gets a vote. If most say yes, you're next, and {name} gets 3 minutes to save.",
    "p.none": "None of your games is on this gaming PC.",
    "p.ask": "Ask the crew",
    "p.cancel": "Cancel",
    "p.busy": "The crew is already voting on who plays next.",

    "v.wants": "{name} wants to play {game} next",
    "v.youWant": "You want to play {game} next",
    "v.handOver": "Should {player} hand over?",
    "v.youHandOver": "Do you want to hand over?",
    "v.tally": "{n} of {of} say yes",
    "v.left": "{time} left",
    "v.yes": "Yes, switch",
    "v.no": "No, keep going",
    "v.fine": "Most votes win. {player} can also just say yes, then you switch right away.",
    "v.youFine": "Most votes win. If you say yes, you switch right away.",
    "v.waiting": "You said yes. Waiting for the others.",
    "v.saidNo": "You said no. Waiting for the others.",
    "v.decidedYes": "The crew voted: {name} is next",
    "v.decidedYesLine": "{player} saves now. In {time} the gaming PC switches.",
    "v.youNext": "The crew voted: you're next",
    "v.youNextLine": "{player} saves now. In {time} the gaming PC is yours.",
    "v.decidedNo": "The crew voted: {player} keeps playing",

    "s.title": "The crew voted: {name} is next",
    "s.line": "Save your game. In {time} the gaming PC switches to {name}.",
    "s.now": "Saved, switch now",
    "s.more": "+2 minutes",

    "e.yourTurn": "Your turn: start {game} on the crew page.",
    "e.toCrew": "To the crew page",
    "e.back": "Back to the wall",
    "e.cancel": "Cancel",
    "e.leave": "Leave",
    "e.notWatching": "Not watching",
    "e.asking": "Asking {name}",
    "e.askingLine": "One moment.",
    "e.asked": "Asked {name}",
    "e.askedLine": "They see your request over their game, and decide. You watch only if they say yes.",
    "e.waiting": "Waiting for {name}",
    "e.waitingLine": "Their connection dropped. Their game shows here again once they're back.",
    "e.yes": "{name} said yes",
    "e.yesLine": "Their game shows here in a moment.",
    "e.declined": "{name} would rather play alone right now.",
    "e.unanswered": "{name} didn't answer. They may be in the middle of something.",
    "e.stopped": "{name} stopped sharing with you.",
    "e.over": "{possessive} session is over.",
    "e.notCrew": "You're no longer in a crew with {name}.",
    "e.full": "As many friends as can are watching {name} already.",
    "e.cooldown": "You asked {name} a moment ago. Give it a minute.",
    "e.noRelay":
      "Watching isn't available here yet. It needs Lanterel's relay, which keeps your addresses private.",
    "e.replaced": "You're watching in another tab.",
    "e.failed": "Watching didn't work out. Try again from the wall.",
  },
  de: {
    "w.playing": "{name} zockt {game}",
    "w.someone": "Jemand aus deiner Crew",
    "w.someoneLower": "jemanden aus deiner Crew",
    "w.theirGame": "das Spiel",
    "w.on": "auf {pc}",
    "w.watchingN": "{n} schauen zu",
    "w.stream": "Stream: {game}, gespielt von {name}",
    "w.crew": "Crew",
    "w.leave": "Stream verlassen",
    "w.soundOn": "Ton an",
    "w.soundOff": "Ton aus",
    "w.joinVoice": "Voice beitreten",
    "w.micOn": "Mikro an",
    "w.micOff": "Mikro aus",
    "w.micRefused": "Dein Browser hat das Mikro nicht erlaubt.",
    "w.mutedBy": "{name} hat dich stummgeschaltet.",
    "w.inVoice": "Im Voice",
    "w.want": "Ich will zocken",

    "m.who": "Wer ist da",
    "m.back": "Zur Crew-Seite",
    "m.leaveCrew": "Crew verlassen",
    "m.nobody": "Noch niemand ist im Voice.",
    "m.player": "zockt",
    "m.muteForMe": "Für mich stumm",
    "m.hear": "Hören",
    "m.leaveTitle": "Crew verlassen?",
    "m.leaveLine": "Du schaust nicht mehr zu, und über den Crew-Link kommst du jederzeit zurück.",
    "m.leaveYes": "Verlassen",
    "m.leaveNo": "Doch bleiben",
    "m.failed": "Das hat nicht geklappt. Versuch es noch mal.",

    "p.title": "Was willst du zocken?",
    "p.line":
      "Die Crew stimmt ab. Sagen die meisten Ja, bist du als Nächstes dran, und {name} hat 3 Minuten zum Speichern.",
    "p.none": "Keins deiner Spiele ist auf diesem Gaming-PC.",
    "p.ask": "Crew fragen",
    "p.cancel": "Abbrechen",
    "p.busy": "Die Crew stimmt schon ab, wer als Nächstes zockt.",

    "v.wants": "{name} will als Nächstes {game} zocken",
    "v.youWant": "Du willst als Nächstes {game} zocken",
    "v.handOver": "Soll {player} abgeben?",
    "v.youHandOver": "Willst du abgeben?",
    "v.tally": "{n} von {of} sind dafür",
    "v.left": "noch {time}",
    "v.yes": "Ja, wechseln",
    "v.no": "Nein, weiter",
    "v.fine": "Die Mehrheit entscheidet. {player} kann auch selbst Ja sagen, dann wird sofort gewechselt.",
    "v.youFine": "Die Mehrheit entscheidet. Sagst du Ja, wird sofort gewechselt.",
    "v.waiting": "Du bist dafür. Die anderen stimmen noch ab.",
    "v.saidNo": "Du bist dagegen. Die anderen stimmen noch ab.",
    "v.decidedYes": "Die Crew hat abgestimmt: {name} ist als Nächstes dran",
    "v.decidedYesLine": "{player} speichert jetzt. In {time} wechselt der Gaming-PC.",
    "v.youNext": "Die Crew hat abgestimmt: Du bist als Nächstes dran",
    "v.youNextLine": "{player} speichert jetzt. In {time} gehört der Gaming-PC dir.",
    "v.decidedNo": "Die Crew hat abgestimmt: {player} zockt weiter",

    "s.title": "Die Crew hat abgestimmt: {name} ist als Nächstes dran",
    "s.line": "Speicher in Ruhe. In {time} wechselt der Gaming-PC zu {name}.",
    "s.now": "Gespeichert, jetzt wechseln",
    "s.more": "+2 Minuten",

    "e.yourTurn": "Du bist dran: Starte {game} auf der Crew-Seite.",
    "e.toCrew": "Zur Crew-Seite",
    "e.back": "Zurück",
    "e.cancel": "Abbrechen",
    "e.leave": "Verlassen",
    "e.notWatching": "Du schaust nicht zu",
    "e.asking": "Wir fragen {name}",
    "e.askingLine": "Einen Moment.",
    "e.asked": "{name} ist gefragt",
    "e.askedLine":
      "Deine Anfrage erscheint über dem Spiel, und {name} entscheidet. Du schaust nur zu, wenn die Antwort Ja ist.",
    "e.waiting": "Warten auf {name}",
    "e.waitingLine": "Die Verbindung ist weg. Das Spiel erscheint hier wieder, sobald {name} zurück ist.",
    "e.yes": "{name} hat Ja gesagt",
    "e.yesLine": "Das Spiel erscheint hier gleich.",
    "e.declined": "{name} zockt gerade lieber allein.",
    "e.unanswered": "{name} hat nicht geantwortet. Vielleicht gerade mitten im Spiel.",
    "e.stopped": "{name} teilt nicht mehr mit dir.",
    "e.over": "{possessive} Zockrunde ist vorbei.",
    "e.notCrew": "Du bist mit {name} in keiner Crew mehr.",
    "e.full": "Es schauen schon so viele zu, wie gehen.",
    "e.cooldown": "Du hast {name} gerade erst gefragt. Warte eine Minute.",
    "e.noRelay":
      "Zuschauen geht hier noch nicht. Dafür braucht es Lanterels Relay, das eure Adressen privat hält.",
    "e.replaced": "Du schaust in einem anderen Tab zu.",
    "e.failed": "Zuschauen hat nicht geklappt. Versuch es noch mal.",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type StreamKey = keyof (typeof STREAM_COPY)["en"];

/** The viewer's words for `lang`, with each `{slot}` filled from `fill`. */
export function streamText(lang: Lang) {
  return (key: StreamKey, fill: Record<string, string | number> = {}) =>
    fillSlots(STREAM_COPY[lang][key], fill);
}

/** Someone's session, as "Maras Zockrunde" or "Mara's session" says it. */
export function theirSession(lang: Lang, name: string): string {
  // "{name}s Crew" in crewCopy's crew.of gives the right possessive ending in both languages.
  return possessive(lang, "crew.of", name).replace(/ (Crew|crew)$/, "");
}
