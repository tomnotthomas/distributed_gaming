// What may never leave a machine in an error report or an analytics event, cut
// out of every string in it before it is sent:
//
//   invite and seat links     /invite/<token> and /seat/<token> become /invite and /seat
//   known secrets             the literal values a caller names (a machine key, its id)
//   tokens and keys           Bearer and Basic credentials, JWTs, `key=`, `token: ...`,
//                             `"sessionKey":"..."` and the like, and any long opaque
//                             string of letters and digits (a key, a hash, an id)
//   Steam IDs                 7656119xxxxxxxxxx
//   e-mail and IP addresses
//   user names in paths       C:\Users\<name>, /Users/<name>, /home/<name> (a Windows name
//                             can hold spaces, so it runs to the next separator or quote)
//
// It errs on the side of cutting: a report missing a value is still a report.

/** An invite or seat link's token in a URL, plain or encoded as a sign-in's return. */
const TOKEN_IN_URL = /(\/|%2F)(invite|seat)(?:\/|%2F)[\w-]+/gi;

/**
 * `value` with every invite link in it cut back to /invite, and every friend
 * seat's link to /seat, however deep: an analytics event's URLs, referrer,
 * person properties and clicked links alike.
 */
export function withoutInviteTokens<T>(value: T): T {
  return deep(value, (text) => text.replace(TOKEN_IN_URL, "$1$2"));
}

/** An IPv4 address, and one group of an IPv6 address. */
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
const HEX = "[0-9a-f]{1,4}";

/**
 * An IPv6 address: in full, or with `::` standing in for zero groups (::1,
 * fe80::1%eth0, ::ffff:1.2.3.4). Not part of a longer word or run of colons, so
 * a file:line:col or a C++ name stays as it is.
 */
const IPV6 = new RegExp(
  String.raw`(?<![\w:])(?:(?:${HEX}:){3,7}${HEX}|(?=[:0-9a-f]*[0-9a-f])(?:${HEX}(?::${HEX}){0,6})?::(?:(?:${HEX}:){0,5}${IPV4}|${HEX}(?::${HEX}){0,6})?)(?:%[\w.-]+)?(?![\w:])`,
  "gi",
);

/** Each pattern, in order, and what it leaves in place of what it found. */
const CUTS: [RegExp, string][] = [
  [TOKEN_IN_URL, "$1$2"],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 <redacted>"],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, "<redacted>"],
  // A secret's name, then = or : (quoted or not), then its value.
  [
    /\b([\w.-]*(?:token|key|secret|password|passwd|ticket|signature|\.sig|credential|cookie|session_?id))(["']?\s*[=:]\s*["']?)[^\s&"',;)}\]]+/gi,
    "$1$2<redacted>",
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [/\b7656119\d{10}\b/g, "<steam-id>"],
  [/\b([A-Za-z]:(?:\\+|\/+)(?:Users|Documents and Settings)(?:\\+|\/+))[^\\/:*?"'<>|\r\n]+/gi, "$1<user>"],
  [/((?:^|[\s"'(=:]|file:\/\/)\/(?:Users|home|var\/home)\/)[^/\s:"'()]+/g, "$1<user>"],
  [IPV6, "<ip>"],
  [new RegExp(String.raw`\b${IPV4}\b`, "g"), "<ip>"],
  // 32 or more letters, digits, - and _, with at least one of each kind: no word or path is that.
  [/\b(?=[\w+-]*\d)(?=[\w+-]*[A-Za-z])[\w+-]{32,}={0,2}/g, "<redacted>"],
];

/** Secrets shorter than this are not cut literally: they would cut ordinary words. */
const MIN_SECRET_LENGTH = 6;

/** `text` with everything above cut out of it, and every one of `secrets` too. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("<redacted>");
  }
  for (const [pattern, replacement] of CUTS) out = out.replace(pattern, replacement);
  return out;
}

/** `value` with scrubText applied to every string in it, however deep. */
export function scrub<T>(value: T, secrets: readonly string[] = []): T {
  return deep(value, (text) => scrubText(text, secrets));
}

/** `value` with `cut` applied to every string in its plain objects and arrays. */
function deep<T>(value: T, cut: (text: string) => string): T {
  if (typeof value === "string") return cut(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => deep(v, cut)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v, cut)])) as T;
  }
  return value;
}
