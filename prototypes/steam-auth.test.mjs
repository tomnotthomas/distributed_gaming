/* Tests for the Steam round trip's identity handling.
 *
 * Run directly, in both configurations, because they behave differently:
 *   STEAM_API_KEY=anything node prototypes/steam-auth.test.mjs
 *   node prototypes/steam-auth.test.mjs
 *
 * Nothing in CI covers prototypes/ yet, so this is run by hand. It is here
 * because this path has already had two bugs that cost nothing at runtime and
 * quietly corrupted the funnel instead, which is the kind that survives review.
 *
 * The denied-path test does reach steamcommunity.com, on purpose: the point is
 * that Steam really does reject a forged assertion, not that a stub says so.
 */
import { loginUrl, returnUrl, signDid, readDid, safeDid } from "./steam-auth.mjs";
const O = "https://swiff.example", ID = "01a0bfde-5d9a-77c7-8250-2020643eaae8";
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS  " : "  FAIL  ") + m); if (!c) fail++; };
const forged = (did) => new URLSearchParams({
  "openid.ns":"http://specs.openid.net/auth/2.0","openid.mode":"id_res",
  "openid.claimed_id":"https://steamcommunity.com/openid/id/76561198000000000",
  "openid.sig":"forged", to:"/play", ...(did ? { did } : {}),
});

console.log(`secret configured: ${Boolean(process.env.STEAM_API_KEY || process.env.SWIFF_DID_SECRET)}`);

console.log("\ne7's attack -- crafted link, denied path:");
const atk = await returnUrl({ origin:O, searchParams: forged("ATTACKERCHOSEN0001"), apiKey:"" });
console.log("  ->", atk);
ok(!atk.includes("ATTACKERCHOSEN"), "well-shaped forged id is rejected");

console.log("\nround trip of a real id:");
const signed = signDid(ID);
const SECRET = Boolean(process.env.STEAM_API_KEY || process.env.SWIFF_DID_SECRET);
if (SECRET) {
  ok(signed.startsWith(ID + "."), "signDid stamps it");
  ok(readDid(signed) === ID, "readDid accepts our own signature");
  ok(readDid(signed.slice(0, -1) + "X") === "", "one flipped char in the sig is rejected");
} else {
  ok(signed === ID, "no secret -> nothing to stamp with");
  ok(readDid(signed) === "", "no secret -> unsigned id is not trusted off the granted path");
}
ok(readDid(ID) === "", "unsigned is rejected where nothing vouched for it");
ok(readDid(ID, { verified: true }) === ID, "unsigned is accepted where Steam did vouch");
ok(readDid("../../evil") === "" && readDid("../../evil", { verified: true }) === "", "malformed rejected on both paths");
ok(readDid(signDid("../../evil")) === "", "malformed is never signed in the first place");

console.log("\nsigned id survives the denied path:");
const legit = await returnUrl({ origin:O, searchParams: forged(signed), apiKey:"" });
console.log("  ->", legit);
ok(legit.includes("steam=denied"), "still denied");
if (SECRET) {
  ok(legit.includes("&did=" + ID), "abandonment still joins to the right person");
  ok(/[#&]did=([^&]*)/.exec(legit)[1] === ID, "signature is stripped before the browser sees it");
} else {
  ok(!/[#&]did=/.test(legit), "no secret -> denied path fails closed, drops the id");
}

console.log("\nloginUrl sends the signed form:");
const rt = new URL(new URL(loginUrl({ origin:O, returnTo:"/play", did:ID })).searchParams.get("openid.return_to"));
ok(rt.searchParams.get("did") === signed, SECRET ? "return_to carries the signed id" : "return_to carries the bare id");
ok(new URL(new URL(loginUrl({ origin:O, returnTo:"/play", did:"../evil" })).searchParams.get("openid.return_to")).searchParams.get("did") === null, "malformed never leaves");
ok(new URL(new URL(loginUrl({ origin:O, returnTo:"https://evil.com/x" })).searchParams.get("openid.return_to")).searchParams.get("to") === "/", "open redirect still closed");

console.log("\nclient-side extraction:");
const RE = /[#&]did=([A-Za-z0-9_-]{8,64})(?:&|$)/;
ok(RE.exec("#steam=eyJhIjoxfQ&did=" + ID)[1] === ID, "extracts did after payload");
ok(/[#&]steam=([^&]+)/.exec("#steam=eyJhIjoxfQ&did=" + ID)[1] === "eyJhIjoxfQ", "payload regex stops at the &");
ok(RE.exec("#steam=eyJhIjoxfQ") === null, "absent did does not crash");
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
