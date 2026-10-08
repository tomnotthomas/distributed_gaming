// The words of removing someone from a crew and taking a gaming PC out of one
// (CrewManage.tsx), from the approved design (data/lanterel-design-round,
// g-remove impeccable), in the crew pages' terms (crewCopy.ts). `{name}`,
// `{crew}`, `{pc}`, `{day}` and `{when}` are filled in where they appear.

import { fillSlots, type Lang } from "./crewCopy";

export const MANAGE_COPY = {
  en: {
    "rm.people": "People in the crew",
    "rm.only": "Only you can remove someone, because you founded the crew.",
    "rm.more": "More about {name}",
    "rm.remove": "Remove from the crew",
    "rm.title": "Remove {name} from the crew?",
    "rm.gone": "{name} won't see {crew} any more and won't get invites.",
    "rm.pc": "{pc} stops playing for the crew.",
    "rm.back": "The crew gets a new invite link. {name} can only come back with that new link.",
    "rm.quiet": "We don't send {name} a message. Tell {name} yourself if you want.",
    "rm.cancel": "Cancel",
    "rm.go": "Remove {name}",
    "rm.done": "{name} is out of the crew.",
    "rm.failed": "That didn't work. Try again.",

    "pcs.title": "Your gaming PC",
    "pcs.plays": "{pc} plays for these crews",
    "pcs.next": "next session {when}",
    "pcs.out": "Take it out of this crew",
    "pcs.playsMany": "Your {n} gaming PCs play for these crews",
    "pcs.strangers": "Strangers never get onto your PC. Only these crews can play on it.",
    "pcs.strangersMany": "Strangers never get onto your PCs. Only these crews can play on them.",
    "pcs.open": "Your PC is open to others too, not just to these crews.",
    "pcs.openMany": "At least one of your PCs is open to others too, not just to these crews.",
    "pcs.askMany": "Take your {n} PCs out of {crew}?",
    "pcs.which": "This takes all of them out: {pcs}.",
    "pcs.stay": "Taking your PC out doesn't take you out. You stay in the crew.",
    "pcs.ask": "Take your PC out of {crew}?",
    "pcs.cant": "{crew} can't play on your PC any more.",
    "pcs.noPc": "The session on {day} then has no gaming PC. The others see that on the crew page.",
    "pcs.youStay": "You stay in the crew.",
    "pcs.keeps": "You stay in the crew. {crews} keeps your PC.",
    "pcs.keepMany": "You stay in the crew. {crews} keep your PC.",
    "pcs.keep": "Keep it in",
    "pcs.go": "Take it out",
    "pcs.fine": "You can add it back any time from the crew page.",
    "pcs.done": "Your PC no longer plays for {crew}.",
  },
  de: {
    "rm.people": "Leute in der Crew",
    "rm.only": "Nur du kannst jemanden entfernen, weil du die Crew gegründet hast.",
    "rm.more": "Mehr zu {name}",
    "rm.remove": "Aus der Crew entfernen",
    "rm.title": "{name} aus der Crew entfernen?",
    "rm.gone": "{name} sieht die Crew {crew} nicht mehr und bekommt keine Einladungen.",
    "rm.pc": "{pc} spielt dann nicht mehr für die Crew.",
    "rm.back": "Die Crew bekommt einen neuen Einladungslink. Zurück kommt {name} nur mit diesem neuen Link.",
    "rm.quiet": "Wir schicken {name} keine Nachricht. Sag es {name} selbst, wenn du willst.",
    "rm.cancel": "Abbrechen",
    "rm.go": "{name} entfernen",
    "rm.done": "{name} ist nicht mehr in der Crew.",
    "rm.failed": "Das hat nicht geklappt. Versuch es noch mal.",

    "pcs.title": "Dein Gaming-PC",
    "pcs.plays": "{pc} spielt für diese Crews",
    "pcs.next": "nächste Zockrunde {when}",
    "pcs.out": "Aus dieser Crew nehmen",
    "pcs.playsMany": "Deine {n} Gaming-PCs spielen für diese Crews",
    "pcs.strangers": "Fremde kommen nie an deinen PC. Nur diese Crews können darauf zocken.",
    "pcs.strangersMany": "Fremde kommen nie an deine PCs. Nur diese Crews können darauf zocken.",
    "pcs.open": "Dein PC ist auch für andere offen, nicht nur für diese Crews.",
    "pcs.openMany": "Mindestens einer deiner PCs ist auch für andere offen, nicht nur für diese Crews.",
    "pcs.askMany": "Deine {n} PCs aus der Crew {crew} nehmen?",
    "pcs.which": "Das nimmt alle raus: {pcs}.",
    "pcs.stay": "Wenn du den PC rausnimmst, bleibst du selbst in der Crew.",
    "pcs.ask": "Deinen PC aus der Crew {crew} nehmen?",
    "pcs.cant": "Die Crew {crew} kann nicht mehr auf deinem PC zocken.",
    "pcs.noPc": "Die Zockrunde am {day} hat dann keinen Gaming-PC. Die anderen sehen das auf der Crew-Seite.",
    "pcs.youStay": "Du bleibst in der Crew.",
    "pcs.keeps": "Du bleibst in der Crew. {crews} behält deinen PC.",
    "pcs.keepMany": "Du bleibst in der Crew. {crews} behalten deinen PC.",
    "pcs.keep": "Drinlassen",
    "pcs.go": "Rausnehmen",
    "pcs.fine": "Du kannst ihn jederzeit auf der Crew-Seite wieder dazuholen.",
    "pcs.done": "Dein PC spielt nicht mehr für {crew}.",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type ManageKey = keyof (typeof MANAGE_COPY)["en"];

/** The words for `lang`, with each `{slot}` filled from `fill`. */
export function manageText(lang: Lang) {
  return (key: ManageKey, fill: Record<string, string | number> = {}) =>
    fillSlots(MANAGE_COPY[lang][key], fill);
}
