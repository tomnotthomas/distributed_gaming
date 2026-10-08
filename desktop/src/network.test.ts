// @vitest-environment node
// How Lanterel OS gets online, read from Windows before Go live: Windows' own
// Wi-Fi profile XML and connectivity names, the same in every display language.

import { describe, expect, it, vi } from "vitest";
import {
  networkOf,
  networkScript,
  parseNetwork,
  profileOf,
  readNetwork,
  securityOf,
  wifiOf,
  wifiToHand,
  type NetworkRead,
  type WifiProfile,
} from "../network.cjs";
import { agreedWifi, networkReady, networkRefusal, networkStop, wifiConsent } from "./network";

/** A profile as WlanGetProfile gives it: this one the GEEKOM's own (WPA3 in transition mode), its password made up. */
function profileXml({
  name = "Brammiball",
  hex = Buffer.from(name, "utf8").toString("hex").toUpperCase(),
  nonBroadcast = null as boolean | null,
  authentication = "WPA3SAE",
  encryption = "AES",
  useOneX = false,
  keyType = "passPhrase" as string | null,
  key = "correct horse 15" as string | null,
} = {}) {
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
	<name>${name}</name>
	<SSIDConfig>
		<SSID>
			<hex>${hex}</hex>
			<name>${name}</name>
		</SSID>${nonBroadcast === null ? "" : `\n\t\t<nonBroadcast>${nonBroadcast}</nonBroadcast>`}
	</SSIDConfig>
	<connectionType>ESS</connectionType>
	<connectionMode>auto</connectionMode>
	<MSM>
		<security>
			<authEncryption>
				<authentication>${authentication}</authentication>
				<encryption>${encryption}</encryption>
				<useOneX>${useOneX}</useOneX>
				<transitionMode xmlns="http://www.microsoft.com/networking/WLAN/profile/v4">true</transitionMode>
			</authEncryption>${
        keyType === null
          ? ""
          : `
			<sharedKey>
				<keyType>${keyType}</keyType>
				<protected>${key === null}</protected>${key === null ? "" : `\n\t\t\t\t<keyMaterial>${key}</keyMaterial>`}
			</sharedKey>`
      }
		</security>
	</MSM>
	<MacRandomization xmlns="http://www.microsoft.com/networking/WLAN/profile/v3">
		<enableRandomization>false</enableRandomization>
		<randomizationSeed>2383598294</randomizationSeed>
	</MacRandomization>
</WLANProfile>`;
}

/** What the read prints: one JSON line, as ConvertTo-Json -Compress writes it. */
const printed = (out: unknown) => `\r\n${JSON.stringify(out)}\r\n`;

const WIFI = (
  profile: Partial<WifiProfile> = {},
  wifi: Partial<NetworkRead["wifi"][number]> = {},
): NetworkRead => ({
  wired: false,
  wifi: [
    {
      network: "Brammiball",
      ipv4: "Internet",
      ipv6: "NoTraffic",
      profiles: [
        {
          ssid: "Brammiball",
          hidden: false,
          authentication: "WPA2PSK",
          encryption: "AES",
          oneX: false,
          keyType: "passPhrase",
          key: "correct horse 15",
          ...profile,
        },
      ],
      ...wifi,
    },
  ],
});

describe("profileOf", () => {
  it("reads the GEEKOM's WPA3 profile, password and all, from Windows' XML", () => {
    expect(profileOf(profileXml())).toEqual({
      ssid: "Brammiball",
      hidden: false,
      authentication: "WPA3SAE",
      encryption: "AES",
      oneX: false,
      keyType: "passPhrase",
      key: "correct horse 15",
    });
  });

  it("takes no password Windows kept encrypted, and none from an open network", () => {
    expect(profileOf(profileXml({ key: null }))?.key).toBeNull();
    expect(
      profileOf(profileXml({ authentication: "open", encryption: "none", keyType: null })),
    ).toMatchObject({
      authentication: "open",
      keyType: null,
      key: null,
    });
  });

  it("names the network by its bytes: a German one with umlauts, and XML's escapes in the password", () => {
    const xml = profileXml({
      name: "Büro &amp; Gäste",
      hex: Buffer.from("Büro & Gäste").toString("hex"),
      key: "a&lt;b&amp;c&gt;d&quot;e",
    });
    expect(profileOf(xml)).toMatchObject({ ssid: "Büro & Gäste", key: 'a<b&c>d"e' });
  });

  it("knows a hidden network, and names none it cannot spell", () => {
    expect(profileOf(profileXml({ nonBroadcast: true }))?.hidden).toBe(true);
    expect(profileOf(profileXml({ hex: "FF00FE" }))).toBeNull();
    expect(profileOf("<WLANProfile/>")).toBeNull();
    expect(profileOf(undefined)).toBeNull();
  });
});

describe("parseNetwork", () => {
  it("reads a Wi-Fi-only PC: the network, how far it reaches, its profiles", () => {
    const out = printed({
      wired: false,
      wifi: { network: "Brammiball", ipv4: "Internet", ipv6: "NoTraffic", profiles: profileXml() },
    });
    expect(parseNetwork(out)).toEqual({
      wired: false,
      wifi: [
        {
          network: "Brammiball",
          ipv4: "Internet",
          ipv6: "NoTraffic",
          profiles: [expect.objectContaining({ ssid: "Brammiball", authentication: "WPA3SAE" })],
        },
      ],
    });
  });

  it("reads the same on a German Windows: the values are Windows' own names, not its display language", () => {
    // Windows names its network list's entries "FRITZ!Box 7590 XY 2" on a second join; the description is the SSID.
    const out = printed({
      wired: false,
      wifi: [
        {
          network: "FRITZ!Box 7590 XY",
          ipv4: "Internet",
          ipv6: "Internet",
          profiles: [profileXml({ name: "FRITZ!Box 7590 XY", authentication: "WPA2PSK" })],
        },
      ],
    });
    expect(networkOf(parseNetwork(out))).toEqual({
      kind: "wifi",
      ssid: "FRITZ!Box 7590 XY",
      security: "psk",
    });
  });

  it("keeps a cable it could not read apart from no cable, and skips profiles that name no network", () => {
    expect(parseNetwork(printed({ wired: null, wifi: [] }))).toEqual({ wired: null, wifi: [] });
    expect(parseNetwork(printed({ wifi: [{ network: "", profiles: ["<x/>"] }] }))).toEqual({
      wired: null,
      wifi: [{ network: null, ipv4: null, ipv6: null, profiles: [] }],
    });
  });

  it("is null for anything but the read's line", () => {
    expect(parseNetwork("")).toBeNull();
    expect(parseNetwork("Add-Type : Cannot add type.")).toBeNull();
    expect(parseNetwork("{ not json")).toBeNull();
  });
});

describe("securityOf", () => {
  const of = (authentication: string, more: Partial<WifiProfile> = {}) =>
    securityOf({ authentication, encryption: "AES", oneX: false, keyType: "passPhrase", ...more });

  it("maps WPA2-Personal to psk, WPA3-Personal (and its transition mode) to sae, open to open", () => {
    expect(of("WPA2PSK")).toBe("psk");
    expect(of("WPA3SAE")).toBe("sae");
    expect(of("open", { encryption: "none", keyType: null })).toBe("open");
  });

  it("calls a sign-in with a user name enterprise", () => {
    for (const auth of ["WPA2", "WPA", "WPA3", "WPA3ENT", "WPA3ENT192"]) expect(of(auth)).toBe("enterprise");
    expect(of("WPA2PSK", { oneX: true })).toBe("enterprise");
  });

  it("joins no WEP, first WPA, Enhanced Open or raw key", () => {
    expect(of("open", { encryption: "WEP", keyType: "networkKey" })).toBeNull();
    expect(of("shared", { encryption: "WEP", keyType: "networkKey" })).toBeNull();
    expect(of("WPAPSK", { encryption: "TKIP" })).toBeNull();
    expect(of("OWE", { keyType: null })).toBeNull();
    expect(of("WPA2PSK", { keyType: "networkKey" })).toBeNull();
  });
});

describe("networkOf", () => {
  it("leaves a PC with a network cable as it was, Wi-Fi or not", () => {
    expect(networkOf({ wired: true, wifi: [] })).toEqual({ kind: "wired" });
    expect(networkOf({ ...WIFI({ authentication: "WPA2" }), wired: true })).toEqual({ kind: "wired" });
  });

  it("hands over a supported Wi-Fi that reaches the internet, never its password", () => {
    expect(networkOf(WIFI())).toEqual({ kind: "wifi", ssid: "Brammiball", security: "psk" });
    expect(networkOf(WIFI({ authentication: "WPA3SAE" }))).toEqual({
      kind: "wifi",
      ssid: "Brammiball",
      security: "sae",
    });
    // Internet over IPv6 alone is internet.
    expect(networkOf(WIFI({}, { ipv4: "LocalNetwork", ipv6: "Internet" })).kind).toBe("wifi");
  });

  it("says what stops each other network", () => {
    expect(networkOf({ wired: false, wifi: [] })).toEqual({ kind: "none" });
    expect(networkOf(WIFI({ authentication: "WPA2" }))).toEqual({ kind: "enterprise", ssid: "Brammiball" });
    // A sign-in web page, or no internet at all: Windows says LocalNetwork until it is passed.
    expect(networkOf(WIFI({}, { ipv4: "LocalNetwork", ipv6: "NoTraffic" }))).toEqual({
      kind: "offline",
      ssid: "Brammiball",
    });
    expect(networkOf(WIFI({}, { ipv4: null, ipv6: null })).kind).toBe("offline");
    expect(networkOf(WIFI({ authentication: "open", encryption: "WEP", keyType: "networkKey" }))).toEqual({
      kind: "unsupported",
      ssid: "Brammiball",
    });
    expect(networkOf(WIFI({ hidden: true })).kind).toBe("unsupported");
  });

  it("is unread when the read failed, or found no profile for the connected network", () => {
    expect(networkOf(null)).toEqual({ kind: "unread" });
    expect(networkOf({ wired: null, wifi: [] })).toEqual({ kind: "unread" });
    expect(networkOf(WIFI({ ssid: "Nachbar" }))).toEqual({ kind: "unread" });
    expect(networkOf(WIFI({}, { network: null }))).toEqual({ kind: "unread" });
  });
});

describe("wifiOf", () => {
  it("is the payload's wifi: name, security and password, none for an open network", () => {
    expect(wifiOf(WIFI())).toEqual({ ssid: "Brammiball", security: "psk", passphrase: "correct horse 15" });
    expect(wifiOf(WIFI({ authentication: "WPA3SAE" }))).toEqual({
      ssid: "Brammiball",
      security: "sae",
      passphrase: "correct horse 15",
    });
    expect(wifiOf(WIFI({ authentication: "open", encryption: "none", keyType: null, key: null }))).toEqual({
      ssid: "Brammiball",
      security: "open",
    });
  });

  it("is none on a cable or a network Lanterel OS cannot join", () => {
    expect(wifiOf({ ...WIFI(), wired: true })).toBeNull();
    expect(wifiOf(WIFI({ authentication: "WPA2" }))).toBeNull();
    expect(wifiOf(null)).toBeNull();
  });

  it("is unsupported without a password Lanterel OS can use", () => {
    expect(wifiOf(WIFI({ key: null }))).toBe("unsupported");
    expect(wifiOf(WIFI({ key: "short" }))).toBe("unsupported");
    expect(wifiOf(WIFI({ key: "x".repeat(64) }))).toBe("unsupported");
    expect(wifiOf(WIFI({ key: "pässwort-mit-umlaut" }))).toBe("unsupported");
  });
});

describe("wifiToHand", () => {
  it("hands over the Wi-Fi the owner agreed to, and nothing on a cable", () => {
    expect(wifiToHand(WIFI(), "Brammiball")).toEqual({
      ssid: "Brammiball",
      security: "psk",
      passphrase: "correct horse 15",
    });
    expect(wifiToHand({ ...WIFI(), wired: true }, null)).toBeNull();
    expect(wifiToHand({ ...WIFI(), wired: true }, "Brammiball")).toBeNull();
  });

  it("stops the run, before anything changes, on any other network: by kind, never with the password", () => {
    const stop = (read: NetworkRead | null, agreed: string | null) => {
      try {
        wifiToHand(read, agreed);
      } catch (error) {
        return (error as Error).message;
      }
      return "handed";
    };
    expect(stop(WIFI(), null)).toBe("changed");
    expect(stop(WIFI(), "Nachbar")).toBe("changed");
    expect(stop(WIFI({}, { ipv4: "LocalNetwork", ipv6: "NoTraffic" }), "Brammiball")).toBe("offline");
    expect(stop(WIFI({ authentication: "WPA2" }), "Brammiball")).toBe("enterprise");
    expect(stop({ wired: false, wifi: [] }, "Brammiball")).toBe("none");
    expect(stop(null, "Brammiball")).toBe("unread");
    expect(stop(WIFI({ key: "short" }), "Brammiball")).toBe("unsupported");
  });
});

describe("readNetwork", () => {
  it("reads nothing off Windows", async () => {
    const run = vi.fn();
    expect(await readNetwork({ platform: "linux", run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs Windows PowerShell with the script encoded, and is null when it fails", async () => {
    const run = vi.fn(
      (_file: string, _args: string[], _options: object, done: (e: Error | null, out: string) => void) =>
        done(null, printed({ wired: true, wifi: [] })),
    );
    expect(await readNetwork({ platform: "win32", env: { SystemRoot: "D:\\Win" }, run })).toEqual({
      wired: true,
      wifi: [],
    });
    const [file, args] = run.mock.calls[0]!;
    expect(file).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(networkScript(false));

    const failing = vi.fn(
      (_f: string, _a: string[], _o: object, done: (e: Error | null, out: string) => void) =>
        done(new Error("timed out"), ""),
    );
    expect(await readNetwork({ platform: "win32", run: failing })).toBeNull();
  });

  it("asks Windows for the password only when it is for Go live's record", () => {
    expect(networkScript(false)).toContain("Connected(0)");
    expect(networkScript(false)).toContain("-replace '<keyMaterial>[^<]*</keyMaterial>', ''");
    expect(networkScript(true)).toContain("Connected(4)");
    expect(networkScript(true)).not.toContain("keyMaterial");
  });
});

describe("what the Go live screen says", () => {
  const SAE = { kind: "wifi", ssid: "Brammiball", security: "sae" } as const;

  it("goes live on a cable or a Wi-Fi it hands over, and agrees to hand over only that Wi-Fi", () => {
    expect(networkReady({ kind: "wired" })).toBe(true);
    expect(networkReady(SAE)).toBe(true);
    expect(networkReady({ kind: "offline", ssid: "x" })).toBe(false);
    expect(networkReady(undefined)).toBe(false);
    expect(networkRefusal({ kind: "wired" })).toBeNull();
    expect(networkRefusal(SAE)).toBeNull();
    expect(agreedWifi(SAE)).toBe("Brammiball");
    expect(agreedWifi({ kind: "wired" })).toBeNull();
    expect(wifiConsent({ kind: "wired" })).toBeNull();
  });

  it("asks the owner's agreement in German on a German Windows", () => {
    expect(wifiConsent(SAE, "de")).toEqual({
      label: "WLAN für Lanterel OS",
      text: "Lanterel OS geht über das WLAN „Brammiball“ online. Wenn du den Knopf gedrückt hältst, bekommt Lanterel OS den Namen und das Passwort dieses WLANs. Beides wird so versiegelt, dass nur Lanterel OS auf diesem PC es lesen kann.",
    });
  });

  it("refuses in one sentence with the one thing to do, in either language", () => {
    expect(networkRefusal({ kind: "enterprise", ssid: "eduroam" }, "de")).toEqual({
      title: "Lanterel OS kann dieses WLAN nicht nutzen",
      why: "„eduroam“ verlangt eine Anmeldung mit Benutzernamen, wie ein Firmen- oder Uni-WLAN, und das kann Lanterel OS nicht: Steck ein Netzwerkkabel ein, dann prüf erneut.",
      label: "Erneut prüfen",
      rail: "Kein Netzwerk",
      off: ["Kein", "Netzwerk"],
    });
    expect(networkRefusal({ kind: "none" }, "en")).toMatchObject({
      title: "Lanterel OS has no network",
      label: "Check again",
      rail: "No network",
    });
    // No read yet is a read that failed.
    expect(networkRefusal(undefined, "en")?.title).toBe("Couldn't check this PC's network");
    for (const kind of ["none", "enterprise", "offline", "unsupported", "unread", "changed"])
      for (const lang of ["en", "de"] as const) expect(networkStop(kind, "x", lang).why).toMatch(/[.]$/);
  });

  it("names the Wi-Fi only when it knows it: a run's stop carries the kind alone", () => {
    expect(networkStop("offline", null, "en").title).toBe("This Wi-Fi has no internet");
    expect(networkStop("offline", null, "de").title).toBe("Dieses WLAN hat kein Internet");
    expect(networkStop("changed", null, "en")).toMatchObject({
      title: "The Wi-Fi changed",
      rail: "Wi-Fi changed",
    });
    expect(networkStop("whatever", null, "en").title).toBe("Couldn't check this PC's network");
  });
});
