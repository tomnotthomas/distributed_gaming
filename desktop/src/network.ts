// What the Go live screen says about Lanterel OS's network (network.cjs): the
// owner's agreement to hand Lanterel OS this PC's Wi-Fi, or why Go live waits
// for a network cable. In German on a German Windows, English elsewhere.

import type { Network } from "../network.cjs";

export type Lang = "en" | "de";

/** The window's language: German when Windows is, else English. */
export const uiLang = (): Lang =>
  typeof navigator !== "undefined" && /^de\b/i.test(navigator.language) ? "de" : "en";

/** Lanterel OS will get online: over a cable, or the connected Wi-Fi Go live hands it. */
export const networkReady = (network: Network | null | undefined): boolean =>
  network?.kind === "wired" || network?.kind === "wifi";

/**
 * Why Go live waits: networkOf's kinds that leave Lanterel OS offline, a Wi-Fi other than the one agreed
 * to, and a password the run's elevated read did not get in the clear (network.cjs wifiToHand).
 */
export type NetworkStop = Exclude<Network["kind"], "wired" | "wifi"> | "changed" | "unreadable";

export type NetworkRefusal = {
  title: string;
  /** One sentence: what is wrong, and the one thing to do. */
  why: string;
  /** The button, which checks the PC again. */
  label: string;
  /** The rail's line, and the dial's while it cannot be held. */
  rail: string;
  off: [string, string];
};

const quoted = (ssid: string, lang: Lang) => (lang === "de" ? `„${ssid}“` : `“${ssid}”`);

const COPY: Record<
  Lang,
  {
    stops: Record<NetworkStop, (ssid: string) => [string, string]>;
    label: string;
    rail: string;
    changedRail: string;
    off: [string, string];
    consent: { label: string; text: (ssid: string) => string };
  }
> = {
  en: {
    stops: {
      none: () => [
        "Lanterel OS has no network",
        "This PC has no network cable and no Wi-Fi connection: plug in a cable or connect to Wi-Fi, then check again.",
      ],
      enterprise: (ssid) => [
        "Lanterel OS can't use this Wi-Fi",
        `${ssid} signs in with a user name, like work or school Wi-Fi, which Lanterel OS can't do: connect a network cable, then check again.`,
      ],
      offline: (ssid) => [
        `${ssid} has no internet`,
        "Windows says this Wi-Fi doesn't reach the internet, or wants you to sign in on a web page, which Lanterel OS can't do: connect a network cable, then check again.",
      ],
      unsupported: (ssid) => [
        "Lanterel OS can't use this Wi-Fi",
        `${ssid} is hidden or uses an older kind of security Lanterel OS can't join: connect a network cable, then check again.`,
      ],
      unread: () => [
        "Couldn't check this PC's network",
        "Lanterel couldn't read how this PC gets online: check again.",
      ],
      changed: () => [
        "The Wi-Fi changed",
        "This PC is on another network than the one this screen showed: check again, then hold the button again.",
      ],
      unreadable: () => [
        "Couldn't read the Wi-Fi password",
        "The Wi-Fi password could not be read: connect a network cable, or try again.",
      ],
    },
    label: "Check again",
    rail: "No network",
    changedRail: "Wi-Fi changed",
    off: ["Needs a", "network"],
    consent: {
      label: "Wi-Fi for Lanterel OS",
      text: (ssid) =>
        `Lanterel OS goes online over this PC's Wi-Fi, ${ssid}. Holding the button hands Lanterel OS the network's name and password, sealed so only Lanterel OS on this PC can read them.`,
    },
  },
  de: {
    stops: {
      none: () => [
        "Lanterel OS hat kein Netzwerk",
        "Dieser PC hat weder ein Netzwerkkabel noch eine WLAN-Verbindung: Steck ein Kabel ein oder verbinde ihn mit einem WLAN, dann prüf erneut.",
      ],
      enterprise: (ssid) => [
        "Lanterel OS kann dieses WLAN nicht nutzen",
        `${ssid} verlangt eine Anmeldung mit Benutzernamen, wie ein Firmen- oder Uni-WLAN, und das kann Lanterel OS nicht: Steck ein Netzwerkkabel ein, dann prüf erneut.`,
      ],
      offline: (ssid) => [
        `${ssid} hat kein Internet`,
        "Laut Windows kommt dieses WLAN nicht ins Internet oder will eine Anmeldung auf einer Webseite, und das kann Lanterel OS nicht: Steck ein Netzwerkkabel ein, dann prüf erneut.",
      ],
      unsupported: (ssid) => [
        "Lanterel OS kann dieses WLAN nicht nutzen",
        `${ssid} ist versteckt oder nutzt eine ältere Verschlüsselung, mit der sich Lanterel OS nicht verbinden kann: Steck ein Netzwerkkabel ein, dann prüf erneut.`,
      ],
      unread: () => [
        "Netzwerk konnte nicht geprüft werden",
        "Lanterel konnte nicht lesen, wie dieser PC ins Internet kommt: Prüf erneut.",
      ],
      changed: () => [
        "Das WLAN hat sich geändert",
        "Dieser PC ist jetzt in einem anderen Netzwerk als dem, das hier stand: Prüf erneut und halte den Knopf dann noch einmal.",
      ],
      unreadable: () => [
        "WLAN-Passwort nicht lesbar",
        "Das WLAN-Passwort konnte nicht gelesen werden: Steck ein Netzwerkkabel ein oder versuch es noch einmal.",
      ],
    },
    label: "Erneut prüfen",
    rail: "Kein Netzwerk",
    changedRail: "WLAN geändert",
    off: ["Kein", "Netzwerk"],
    consent: {
      label: "WLAN für Lanterel OS",
      text: (ssid) =>
        `Lanterel OS geht über das WLAN ${ssid} online. Wenn du den Knopf gedrückt hältst, bekommt Lanterel OS den Namen und das Passwort dieses WLANs. Beides wird so versiegelt, dass nur Lanterel OS auf diesem PC es lesen kann.`,
    },
  },
};

/** Whether a run's error is a network stop: main's check as the run starts, or the worker's as it writes the record. */
export const isNetworkStop = (error: string): boolean => Object.hasOwn(COPY.en.stops, error);

/** What a stop says, for the network it stopped on: a run's stop names only its kind, the network the Wi-Fi's name. */
export function networkStop(stop: string, ssid: string | null = null, lang: Lang = uiLang()): NetworkRefusal {
  const copy = COPY[lang];
  const known = Object.hasOwn(copy.stops, stop) ? (stop as NetworkStop) : "unread";
  const [title, why] = copy.stops[known](
    ssid === null ? (lang === "de" ? "Dieses WLAN" : "This Wi-Fi") : quoted(ssid, lang),
  );
  return {
    title,
    why,
    label: copy.label,
    rail: known === "changed" ? copy.changedRail : copy.rail,
    off: copy.off,
  };
}

/** Why Go live waits for this network, or null when Lanterel OS will get online. No read yet counts as unread. */
export function networkRefusal(
  network: Network | null | undefined,
  lang: Lang = uiLang(),
): NetworkRefusal | null {
  if (networkReady(network)) return null;
  const stop = network ?? { kind: "unread" as const };
  return networkStop(stop.kind, "ssid" in stop ? stop.ssid : null, lang);
}

/** What holding Go live agrees to on a Wi-Fi PC: its name and password go to Lanterel OS. Null on a cable. */
export function wifiConsent(
  network: Network | null | undefined,
  lang: Lang = uiLang(),
): { label: string; text: string } | null {
  if (network?.kind !== "wifi") return null;
  const { consent } = COPY[lang];
  return { label: consent.label, text: consent.text(quoted(network.ssid, lang)) };
}

/** The Wi-Fi Go live hands Lanterel OS, by name, for main to hold the run to (main.cjs rental:run); null on a cable. */
export const agreedWifi = (network: Network | null | undefined): string | null =>
  network?.kind === "wifi" ? network.ssid : null;
