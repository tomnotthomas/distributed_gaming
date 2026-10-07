// The crew page, the crew link's invite and the seat link's page, laid out
// from the phone to a large screen: at every width the page fits the window
// sideways, so nothing scrolls or hangs off the edge.

import { expect, test, type Page } from "@playwright/test";
import { E2E_CREW_PC_OWNER, E2E_SEAT_PC, E2E_SEAT_PC_KEY, signIn } from "./credentials";
import { failOnPageError } from "./hosts";

const FOUNDER = "76561198000000301";
const WIDTHS = [390, 768, 1024, 1280, 1440, 1920];

/** Every width in turn: the page's content is no wider than its window. */
async function fitsEveryWidth(page: Page, ready: () => Promise<void>) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await ready();
    const sideways = await page.evaluate(() => {
      const root = document.documentElement;
      // The app scrolls in a box of its own (overflow-y: auto): that box is the window, so it
      // may neither scroll nor clip sideways. A box that clips without scrolling (the art, the
      // banner's rays) fits its contents itself.
      const scroller = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowY);
      const scrollers: Element[] = [root];
      for (let up = document.querySelector("main")?.parentElement; up && up !== root; up = up.parentElement) {
        if (scroller(up)) scrollers.push(up);
      }
      const clipped = (el: Element) => {
        for (let up = el.parentElement; up && up !== root; up = up.parentElement) {
          if (!scroller(up) && /hidden|clip/.test(getComputedStyle(up).overflowX)) return true;
        }
        return false;
      };
      const wider = [...document.querySelectorAll("main *")].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.right > root.clientWidth + 0.5 || box.left < -0.5) && !clipped(el);
      });
      // A heading's words stay inside its column rather than run under the next one.
      const spilled = [...document.querySelectorAll("main :is(h1, h2, h3)")].filter(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      return {
        scroll: Math.max(...scrollers.map((el) => el.scrollWidth - el.clientWidth)),
        spilled: spilled.map((el) => el.textContent),
        wider: wider.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
      };
    });
    expect.soft(sideways, `at ${width}px`).toEqual({ scroll: 0, spilled: [], wider: [] });
  }
}

test("the crew page, its invite and a seat's page fit every width from phone to large screen", async ({
  browser,
  baseURL,
  request,
}) => {
  const founderContext = await browser.newContext();
  await signIn(founderContext, baseURL!, FOUNDER);
  const founder = await founderContext.newPage();
  const founderErrors = failOnPageError(founder, "founder");
  await founder.goto("/crews?found=1");
  await expect(founder).toHaveURL(/\/crews\/[\w-]{22}$/);
  const crewId = new URL(founder.url()).pathname.split("/").pop()!;
  const { crew } = await (await founder.request.get(`/api/crews/${crewId}`)).json();
  await fitsEveryWidth(founder, () =>
    expect(founder.getByRole("heading", { name: "When are you playing?" })).toBeVisible(),
  );

  const friendContext = await browser.newContext();
  await signIn(friendContext, baseURL!, E2E_CREW_PC_OWNER);
  const friend = await friendContext.newPage();
  const friendErrors = failOnPageError(friend, "friend");
  await friend.goto(`/invite/${crew.token}`);
  await fitsEveryWidth(friend, () =>
    expect(friend.getByTestId("invite")).toHaveAttribute("data-state", /.+/),
  );

  // A host app keeps seats at a PC it has offered once.
  const hostApp = { authorization: `Bearer ${E2E_SEAT_PC_KEY}` };
  for (const available of [true, false]) {
    const offered = await request.put(`/api/machines/${E2E_SEAT_PC}/availability`, {
      headers: hostApp,
      data: { available, crewOnly: true, name: "Lenas PC", net: { rttMs: 1, jitterMs: 1, upMbps: 100 } },
    });
    expect(offered.status()).toBe(200);
  }
  const made = await request.post(`/api/machines/${E2E_SEAT_PC}/seats`, {
    headers: hostApp,
    data: { friend: "Mara" },
  });
  expect(made.status()).toBe(201);
  const { seat } = await made.json();
  await friend.goto(`/seat/${seat.token}`);
  await fitsEveryWidth(friend, () => expect(friend.getByTestId("seat")).toHaveAttribute("data-state", /.+/));
  await request.delete(`/api/machines/${E2E_SEAT_PC}/seats?seat=${seat.id}`, { headers: hostApp });

  expect([...founderErrors, ...friendErrors]).toEqual([]);
  await founderContext.close();
  await friendContext.close();
});
