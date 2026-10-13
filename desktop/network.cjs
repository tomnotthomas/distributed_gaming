// How Lanterel OS will get online on this PC, read from Windows before Go live:
// over a network cable when one is plugged in, or else over the Wi-Fi network
// this PC is connected to, whose name and password Go live hands Lanterel OS
// in the provisioning record (provision.cjs `wifi`). Lanterel OS joins one
// open, WPA2-Personal or WPA3-Personal network by itself; anything else (a
// work or school sign-in, a sign-in web page, older or hidden Wi-Fi) needs a
// cable, which the app says before Go live.
//
// One PowerShell run, without administrator rights: the physical adapters
// (Get-NetAdapter), the Wi-Fi network Windows is connected to (its network
// list, whose description is the network's name: Windows 11 keeps the
// connected SSID from WLAN's own calls without location access), whether it
// reaches the internet (Get-NetConnectionProfile), and the connected Wi-Fi's
// saved profile from the WLAN API, as Windows' own profile XML: the same in
// every display language. The connected network's password, and no other
// saved network's, is in what the read gives only when the run asks for it
// (`withKey`): only the elevated installer worker does, as it
// writes Go live's record (rental-worker.cjs), since Windows gives it in the
// clear to administrators only. It goes nowhere but into the record, and is
// never logged, reported or shown. Nothing is written to disk.

const { execFile } = require("node:child_process");
const { encodeCommand, powershell } = require("./probe.cjs");
const { wifiProblem } = require("./provision.cjs");

/** How long the read may take: compiling the WLAN calls is most of it. */
const NETWORK_TIMEOUT_MS = 30_000;

// WLAN API: the interfaces (WLAN_INTERFACE_INFO, 532 bytes: GUID, a
// 256-WCHAR description, the state; 1 is connected), each connected one's
// profiles (WLAN_PROFILE_INFO, 516 bytes: a 256-WCHAR name, flags) and their
// XML. WLAN_PROFILE_GET_PLAINTEXT_KEY (4) puts the password in it in the
// clear; the key is dropped from the XML before it is printed without it, and
// with it from every profile but the connected network's.
const networkScript = (withKey) => String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$out = [ordered]@{ wired = $null; wifi = @() }
try {
  $out.wired = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.NdisPhysicalMedium -eq 14 }).Count -gt 0
} catch {}
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SwiffWlan {
  [DllImport("wlanapi.dll")] static extern int WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
  [DllImport("wlanapi.dll")] static extern int WlanCloseHandle(IntPtr handle, IntPtr reserved);
  [DllImport("wlanapi.dll")] static extern int WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern int WlanGetProfileList(IntPtr handle, ref Guid iface, IntPtr reserved, out IntPtr list);
  [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)] static extern int WlanGetProfile(IntPtr handle, ref Guid iface, string name, IntPtr reserved, out IntPtr xml, ref uint flags, out uint access);
  [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);
  public static List<object[]> Connected(uint flags) {
    var found = new List<object[]>();
    IntPtr handle; uint negotiated;
    if (WlanOpenHandle(2, IntPtr.Zero, out negotiated, out handle) != 0) return found;
    try {
      IntPtr interfaces;
      if (WlanEnumInterfaces(handle, IntPtr.Zero, out interfaces) != 0) return found;
      try {
        int count = Marshal.ReadInt32(interfaces);
        for (int i = 0; i < count; i++) {
          IntPtr at = new IntPtr(interfaces.ToInt64() + 8 + i * 532);
          if (Marshal.ReadInt32(at, 528) != 1) continue;
          Guid id = (Guid)Marshal.PtrToStructure(at, typeof(Guid));
          var profiles = new List<string>();
          IntPtr list;
          if (WlanGetProfileList(handle, ref id, IntPtr.Zero, out list) == 0) {
            try {
              int names = Marshal.ReadInt32(list);
              for (int j = 0; j < names; j++) {
                string name = Marshal.PtrToStringUni(new IntPtr(list.ToInt64() + 8 + j * 516));
                IntPtr xml; uint asked = flags; uint access;
                if (WlanGetProfile(handle, ref id, name, IntPtr.Zero, out xml, ref asked, out access) != 0) continue;
                profiles.Add(Marshal.PtrToStringUni(xml));
                WlanFreeMemory(xml);
              }
            } finally { WlanFreeMemory(list); }
          }
          found.Add(new object[] { id, profiles.ToArray() });
        }
      } finally { WlanFreeMemory(interfaces); }
    } finally { WlanCloseHandle(handle, IntPtr.Zero); }
    return found;
  }
}
'@
  $nlm = [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]'DCB00C01-570F-4A9B-8D69-199FDBA5723B'))
  $described = @{}
  foreach ($n in $nlm.GetNetworks(1)) { $described[$n.GetName()] = $n.GetDescription() }
  $out.wifi = @([SwiffWlan]::Connected(${withKey ? 4 : 0}) | ForEach-Object {
    $guid = '{' + $_[0].ToString() + '}'
    $connection = $null
    try {
      $index = (Get-NetAdapter -Physical | Where-Object { $_.InterfaceGuid -eq $guid }).InterfaceIndex
      $connection = Get-NetConnectionProfile -InterfaceIndex $index | Select-Object -First 1
    } catch {}
    $network = if ($connection) { $described[$connection.Name] } else { $null }
    @{
      network = $network
      ipv4 = if ($connection) { [string]$connection.IPv4Connectivity } else { $null }
      ipv6 = if ($connection) { [string]$connection.IPv6Connectivity } else { $null }
      profiles = @($_[1] | ForEach-Object { ${
        withKey
          ? "if ($network -and $(try { $ssid = ([xml]$_).WLANProfile.SSIDConfig.SSID; if ($ssid.hex) { @($ssid.hex) -icontains [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($network)).Replace('-', '') } else { @($ssid.name) -ccontains $network } } catch { $false })) { $_ } else { $_ -replace '<keyMaterial>[^<]*</keyMaterial>', '' }"
          : "$_ -replace '<keyMaterial>[^<]*</keyMaterial>', ''"
      } })
    }
  })
} catch {}
$out | ConvertTo-Json -Compress -Depth 4
`;

/** The text of `xml`'s first `<tag>`, its entities decoded; null when there is none. */
function xmlText(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  if (!match) return null;
  return match[1].replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) =>
    hex
      ? String.fromCodePoint(parseInt(hex, 16))
      : dec
        ? String.fromCodePoint(Number(dec))
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()],
  );
}

/** The section of `xml` inside its first `<tag>`, or "" when there is none. */
const xmlSection = (xml, tag) =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";

/** An SSID's bytes as text, or null when they are not UTF-8 Lanterel OS could name. */
function ssidOf(hex, name) {
  if (hex && /^(?:[0-9a-f]{2}){1,32}$/i.test(hex)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex"));
    } catch {
      return null;
    }
  }
  return name && Buffer.byteLength(name, "utf8") <= 32 ? name : null;
}

/**
 * A saved Wi-Fi profile's XML (WLANProfile, as WlanGetProfile gives it), as
 * the fields Lanterel OS's join needs; null when it names no network.
 */
function profileOf(xml) {
  if (typeof xml !== "string") return null;
  const ssid = xmlSection(xmlSection(xml, "SSIDConfig"), "SSID");
  const security = xmlSection(xml, "security");
  const auth = xmlSection(security, "authEncryption");
  const shared = xmlSection(security, "sharedKey");
  const name = ssidOf(xmlText(ssid, "hex"), xmlText(ssid, "name"));
  if (name === null) return null;
  return {
    ssid: name,
    hidden: xmlText(xmlSection(xml, "SSIDConfig"), "nonBroadcast") === "true",
    authentication: xmlText(auth, "authentication") ?? "",
    encryption: xmlText(auth, "encryption") ?? "",
    oneX: xmlText(auth, "useOneX") === "true",
    keyType: xmlText(shared, "keyType"),
    // Only a key Windows gave in the clear: a protected one is Windows' own encryption of it.
    key: xmlText(shared, "protected") === "false" ? xmlText(shared, "keyMaterial") : null,
  };
}

/**
 * What the read printed: whether a network cable is plugged in (null when
 * unread), and each connected Wi-Fi interface with its network's name, how
 * far Windows says it reaches, and the profiles saved on it, a password only
 * on the connected network's. Null when the
 * output is not the read's.
 */
function parseNetwork(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("{"));
  let raw;
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  // ConvertTo-Json writes a list of one as the one.
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const text = (value) => (typeof value === "string" && value ? value : null);
  return {
    wired: typeof raw.wired === "boolean" ? raw.wired : null,
    wifi: list(raw.wifi).map((w) => ({
      network: text(w?.network),
      ipv4: text(w?.ipv4),
      ipv6: text(w?.ipv6),
      profiles: list(w?.profiles).flatMap((xml) => {
        const profile = profileOf(xml);
        if (!profile) return [];
        return profile.ssid === text(w?.network) ? profile : { ...profile, key: null };
      }),
    })),
  };
}

/**
 * The payload's security for a profile's authentication (and 802.1X), or
 * "enterprise" for a work or school sign-in, or null for what Lanterel OS
 * does not join: WEP, WPA (the first one), Enhanced Open, a raw key.
 */
function securityOf({ authentication, encryption, oneX, keyType }) {
  const auth = authentication.toUpperCase();
  if (oneX || ["WPA", "WPA2", "WPA3", "WPA3ENT", "WPA3ENT192"].includes(auth)) return "enterprise";
  if (auth === "OPEN") return encryption.toUpperCase() === "NONE" ? "open" : null;
  if (keyType !== "passPhrase") return null;
  return { WPA2PSK: "psk", WPA3SAE: "sae" }[auth] ?? null;
}

/**
 * What Lanterel OS gets online over, from a read (parseNetwork):
 *
 *   wired        a network cable is plugged in: Lanterel OS uses it, as before
 *   wifi         the connected Wi-Fi, which Go live hands Lanterel OS
 *   none         no cable and no Wi-Fi connection
 *   enterprise   the Wi-Fi signs in with a user name (802.1X)
 *   offline      Windows says the Wi-Fi does not reach the internet: no
 *                internet, or a sign-in web page (a captive portal)
 *   unsupported  WEP, the first WPA, Enhanced Open, a hidden network, or a
 *                password Lanterel OS cannot take
 *   unread       the read failed, or found no saved profile for the network
 *
 * Never the password: the read for the screen does not carry it.
 */
function networkOf(read) {
  if (!read) return { kind: "unread" };
  if (read.wired) return { kind: "wired" };
  const wifi = read.wifi.find((w) => w.network !== null) ?? read.wifi[0];
  if (!wifi) return read.wired === null ? { kind: "unread" } : { kind: "none" };
  const profile = wifi.profiles.find((p) => p.ssid === wifi.network);
  if (!profile) return { kind: "unread" };
  const { ssid } = profile;
  const security = securityOf(profile);
  if (security === "enterprise") return { kind: "enterprise", ssid };
  if (!security || profile.hidden) return { kind: "unsupported", ssid };
  if (wifi.ipv4 !== "Internet" && wifi.ipv6 !== "Internet") return { kind: "offline", ssid };
  return { kind: "wifi", ssid, security };
}

/**
 * What Lanterel OS gets online over as the run starts, from a read without the
 * password: wired or the Wi-Fi the owner agreed to hand over (`agreed`, its
 * name as the Go live screen showed it). Throws, with networkOf's kind as its
 * message, when Lanterel OS would have no network it can join, or "changed"
 * when it is not the agreed Wi-Fi.
 */
function networkToHand(read, agreed) {
  const network = networkOf(read);
  if (network.kind === "wired") return network;
  if (network.kind !== "wifi") throw new Error(network.kind);
  if (network.ssid !== agreed) throw new Error("changed");
  return network;
}

/**
 * The provisioning's `wifi` (provision.cjs) the elevated worker hands Lanterel
 * OS, from its read made `withKey`: null when a network cable is plugged in.
 * Throws as networkToHand does, "unreadable" when Windows did not give the
 * password in the clear, and "unsupported" when it is not one Lanterel OS can
 * use. Never quotes the password.
 */
function wifiToHand(read, agreed) {
  const network = networkToHand(read, agreed);
  if (network.kind === "wired") return null;
  const { ssid, security } = network;
  if (security === "open") return { ssid, security };
  const key = read.wifi.find((w) => w.network === ssid)?.profiles.find((p) => p.ssid === ssid)?.key;
  if (typeof key !== "string") throw new Error("unreadable");
  const wifi = { ssid, security, passphrase: key };
  if (wifiProblem(wifi)) throw new Error("unsupported");
  return wifi;
}

/**
 * This PC's network read (parseNetwork); null anywhere but Windows, or when
 * PowerShell cannot run it. `withKey` reads the connected Wi-Fi's password
 * too: only in the elevated worker, for Go live's record.
 */
function readNetwork({
  withKey = false,
  platform = process.platform,
  env = process.env,
  run = execFile,
} = {}) {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    run(
      powershell(env),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(networkScript(withKey))],
      { timeout: NETWORK_TIMEOUT_MS, windowsHide: true },
      // The output may hold the password: it is parsed, never kept or passed on as text.
      (error, stdout) => resolve(error ? null : parseNetwork(stdout)),
    );
  });
}

module.exports = {
  networkOf,
  networkScript,
  networkToHand,
  parseNetwork,
  profileOf,
  readNetwork,
  securityOf,
  wifiToHand,
};
