// The Windows VM test's hands on Swiff Host's real window (vm/windows-install-test.sh,
// scenario 13): Electron's remote debugging on 127.0.0.1:9222, tunnelled from the VM,
// driven with Playwright. One command per call, one JSON line out.
//   node ui-drive.mjs screen                    the h1, the rail, the pills, the main text
//   node ui-drive.mjs click <name>              click the button whose accessible name matches (regex, i)
//   node ui-drive.mjs wait-h1 <regex> <seconds> wait until the h1 matches
//   node ui-drive.mjs wait-gone <name> <seconds> wait until no button's accessible name matches (a check still running)
//   node ui-drive.mjs shot <file>               screenshot of the window
//   node ui-drive.mjs code                      the key code on the plate, digits only, and nothing else
// The key code lets whoever has it enrol a key at the blue screen: every answer
// but `code` shows it as (code), so it never lands in the test's logs.
import { chromium } from "playwright";
const [cmd, ...args] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30_000 });
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => !p.url().includes("view=tray"));
const say = (o) => console.log(JSON.stringify(o));
const hide = (text) => text.replace(/\b\d{4} ?\d{4}\b/g, "(code)");
const screen = async () => ({
  h1:
    (
      await page
        .locator("h1")
        .first()
        .textContent({ timeout: 5000 })
        .catch(() => null)
    )?.trim() ?? null,
  rail: (await page.locator("nav.path li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()),
  nav: (
    await page
      .locator("nav.path")
      .innerText()
      .catch(() => "")
  ).replace(/\s+/g, " "),
  pills: (await page.locator("main .lpill, main button.lpill").allInnerTexts()).map((t) => t.trim()),
  text: hide(
    (
      await page
        .locator("main")
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 1200),
  ),
});
try {
  if (cmd === "screen") say({ ok: true, ...(await screen()) });
  else if (cmd === "code")
    console.log(
      ((await page.locator(".mplatecode").first().textContent({ timeout: 5000 })) ?? "").replace(/\D/g, ""),
    );
  else if (cmd === "click") {
    await page
      .getByRole("button", { name: new RegExp(args[0], "i") })
      .first()
      .click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    say({ ok: true, clicked: args[0], ...(await screen()) });
  } else if (cmd === "wait-h1") {
    const re = new RegExp(args[0], "i");
    const end = Date.now() + Number(args[1] ?? 60) * 1000;
    let s = await screen();
    while (!re.test(s.h1 ?? "") && Date.now() < end) {
      await page.waitForTimeout(1000);
      s = await screen();
    }
    say({ ok: re.test(s.h1 ?? ""), ...s });
  } else if (cmd === "wait-gone") {
    const buttons = page.getByRole("button", { name: new RegExp(args[0], "i") });
    const end = Date.now() + Number(args[1] ?? 60) * 1000;
    while ((await buttons.count()) > 0 && Date.now() < end) await page.waitForTimeout(1000);
    say({ ok: (await buttons.count()) === 0, ...(await screen()) });
  } else if (cmd === "shot") {
    await page.screenshot({ path: args[0] });
    say({ ok: true, shot: args[0] });
  } else say({ ok: false, error: `unknown command ${cmd}` });
} catch (error) {
  say({ ok: false, error: error.message.split("\n")[0], ...(await screen().catch(() => ({}))) });
}

process.exit(0);
