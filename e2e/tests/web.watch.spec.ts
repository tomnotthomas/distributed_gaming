// Watching a friend play, end to end: a crewmate sees the player busy on the
// PC, asks to watch, the player says yes over the game, and the crewmate sees
// the game, view only. Both join the voice chat and each hears the other.
// The player stops it, and the crewmate is told.
//
// The browser /host page stands in for the gaming PC, as in web.play.spec.ts.
// Each page's peer connections are kept (an init script) only to read their
// stats: the voice energy each side receives, and that no viewer connection
// ever carries a data channel.

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { E2E_TURN_URL, signIn } from "./credentials";
import { failOnPageError, fakeScreenCapture, offerHost, startHost } from "./hosts";

test.describe.configure({ mode: "serial" });

const PLAYER = "76561198000000001";
const FRIEND = "76561198000000002";

/** Keep every peer connection the page makes, and every data channel it is offered or makes. */
async function keepConnections(page: Page) {
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const kept: RTCPeerConnection[] = [];
    const channels: string[] = [];
    class Kept extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        kept.push(this);
        this.addEventListener("datachannel", (e) => channels.push(`offered:${e.channel.label}`));
      }
      override createDataChannel(label: string, init?: RTCDataChannelInit) {
        channels.push(`made:${label}`);
        return super.createDataChannel(label, init);
      }
    }
    Object.assign(window, { RTCPeerConnection: Kept, __kept: kept, __channels: channels });
  });
}

/**
 * The audio energy received so far on transceiver `mid` across the page's
 * open connections, as Chrome counts it. Grows only while someone speaks:
 * the fake microphone's tone.
 */
const voiceEnergy = (page: Page, mid: string, onlyViewerLinks = false) =>
  page.evaluate(
    async ({ mid, onlyViewerLinks }) => {
      let energy = 0;
      for (const pc of (window as unknown as { __kept: RTCPeerConnection[] }).__kept) {
        if (pc.connectionState === "closed") continue;
        // The player's own connection to the PC has one audio line at most; a viewer link has five.
        if (onlyViewerLinks && pc.getTransceivers().length < 6) continue;
        (await pc.getStats()).forEach(
          (s: { type: string; kind?: string; mid?: string; totalAudioEnergy?: number }) => {
            if (s.type === "inbound-rtp" && s.kind === "audio" && s.mid === mid)
              energy += s.totalAudioEnergy ?? 0;
          },
        );
      }
      return energy;
    },
    { mid, onlyViewerLinks },
  );

/** The candidate types of the page's open connections' selected pairs, local and remote, deduplicated. */
const candidateTypes = (page: Page) =>
  page.evaluate(async () => {
    const local = new Set<string>();
    const remote = new Set<string>();
    for (const pc of (window as unknown as { __kept: RTCPeerConnection[] }).__kept) {
      if (pc.connectionState !== "connected") continue;
      const stats = new Map<string, { type: string; [k: string]: unknown }>();
      (await pc.getStats()).forEach((s: { id: string; type: string }) => stats.set(s.id, s));
      for (const s of stats.values()) {
        if (s.type !== "transport" || typeof s.selectedCandidatePairId !== "string") continue;
        const pair = stats.get(s.selectedCandidatePairId);
        local.add(String(stats.get(String(pair?.localCandidateId))?.candidateType));
        remote.add(String(stats.get(String(pair?.remoteCandidateId))?.candidateType));
      }
    }
    return { local: [...local], remote: [...remote] };
  });

/** Wake the player's HUD, which the crew panel hides with, so the next click lands on it. */
async function wakeHud(page: Page) {
  await page.mouse.move(400, 300);
  await page.mouse.move(420 + Math.random() * 40, 320);
  await expect(page.getByTestId("session")).toHaveAttribute("data-hud", "shown");
}

test.describe("watching a friend play", () => {
  const contexts: BrowserContext[] = [];

  async function openPage(browser: Browser, steamId: string, baseURL: string): Promise<Page> {
    const context = await browser.newContext({ permissions: ["microphone"] });
    contexts.push(context);
    await signIn(context, baseURL, steamId);
    const page = await context.newPage();
    await keepConnections(page);
    return page;
  }

  test.afterEach(async ({ request }) => {
    await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => {})));
    await offerHost(request, false);
    await new Promise((r) => setTimeout(r, 400));
  });

  /** The friend joins the player's crew, and the player launches on the PC and plays. */
  async function playerPlays(browser: Browser, baseURL: string, request: APIRequestContext) {
    await offerHost(request, true);
    const player = await openPage(browser, PLAYER, baseURL);
    const friend = await openPage(browser, FRIEND, baseURL);
    const playerErrors = failOnPageError(player, "player");
    const friendErrors = failOnPageError(friend, "friend");

    // The friend joins the player's crew by the player's invite link.
    await player.goto("/");
    const token = await player.evaluate(
      async () => ((await (await fetch("/api/me/invite")).json()) as { token: string }).token,
    );
    await friend.goto("/");
    expect(
      await friend.evaluate(
        async (t) => (await fetch(`/api/invites/${t}/join`, { method: "POST" })).status,
        token,
      ),
    ).toBe(200);

    // The player launches on the PC and plays.
    const hero = player.getByTestId("hero");
    await expect(hero.locator(".hero-strip-line")).toContainText("E2E rig");
    await hero.locator("button.resume").click();
    const launch = player.getByRole("button", { name: "Hold to launch on E2E rig" });
    await launch.click();
    await launch.hover();
    await player.mouse.down();
    await player.waitForTimeout(900);
    await player.mouse.up();
    const host = await browser.newContext().then(async (context) => {
      contexts.push(context);
      const page = await context.newPage();
      await fakeScreenCapture(page);
      await startHost(page);
      return page;
    });
    await expect(player.getByTestId("ignition")).toHaveCount(0, { timeout: 60_000 });
    const playing = () =>
      player.evaluate(async () => {
        const play = JSON.parse(localStorage.getItem("swiff.play") ?? "null") as { bookingId: string };
        return ((await (await fetch(`/api/bookings/${play.bookingId}`)).json()) as { status: string }).status;
      });
    await expect.poll(playing, { timeout: 15_000 }).toBe("playing");
    return { player, friend, host, playing, playerErrors, friendErrors };
  }

  test("a crewmate asks, the player says yes, the crewmate watches view only, and they talk both ways", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.skip(
      !E2E_TURN_URL,
      "watching is relay-only: start e2e/scripts/turn.sh and set E2E_TURN_URL (CI does)",
    );
    test.setTimeout(180_000);
    const { player, friend, host, playing, playerErrors, friendErrors } = await playerPlays(
      browser,
      baseURL!,
      request,
    );

    // The friend sees who is playing, and asks to watch.
    await friend.reload();
    const line = friend.getByTestId("crew-live-line");
    await expect(line).toContainText("is playing", { timeout: 30_000 });
    await line.getByRole("button", { name: "Ask to watch" }).click();
    await expect(friend.getByTestId("watch-wait")).toContainText("They see your request over their game");

    // The player gets the request over the game, and says yes.
    const asks = player.getByTestId("crew-asks");
    await expect(asks).toContainText("would like to watch you play", { timeout: 15_000 });
    await asks.getByRole("button", { name: "Let them watch" }).click();

    // The friend sees the game.
    const watched = friend.getByTestId("watch-video");
    await expect
      .poll(() => watched.evaluate((v: HTMLVideoElement) => v.videoWidth), {
        timeout: 30_000,
        message: "the friend never saw the player's game",
      })
      .toBeGreaterThan(0);
    await expect(friend.getByTestId("watch")).toHaveAttribute("data-phase", "watching");
    // Relay-only: the friend's connection knows no address of the player's but the relay's.
    expect(await candidateTypes(friend)).toEqual({ local: ["relay"], remote: ["relay"] });
    // View only: no data channel on any connection of the friend's, made or offered.
    expect(await friend.evaluate(() => (window as unknown as { __channels: string[] }).__channels)).toEqual(
      [],
    );

    // Voice, both ways: each joins, and each receives the other's voice.
    const panel = player.getByTestId("crew-panel");
    await expect(panel.getByTestId("crew-watcher")).toHaveCount(1);
    await wakeHud(player);
    await panel.getByRole("button", { name: "Join voice" }).click();
    await friend.getByTestId("watch-crew").getByRole("button", { name: "Join voice" }).click();
    // The player's voice reaches the friend on the voice line (mid 2), the friend's the player.
    await expect
      .poll(() => voiceEnergy(friend, "2"), { timeout: 20_000, message: "the friend never heard the player" })
      .toBeGreaterThan(0);
    await expect
      .poll(() => voiceEnergy(player, "2", true), {
        timeout: 20_000,
        message: "the player never heard the friend",
      })
      .toBeGreaterThan(0);

    // Watching cost the player nothing: the session plays on as it was.
    expect(await playing()).toBe("playing");

    // The player stops it, and the friend is told.
    await wakeHud(player);
    await panel.getByRole("button", { name: "Stop" }).click();
    await expect(friend.getByTestId("watch-wait")).toContainText("stopped sharing with you", {
      timeout: 15_000,
    });

    await friend.getByRole("button", { name: "Back to the wall" }).click();
    await expect(friend.getByTestId("watch")).toHaveCount(0);
    await wakeHud(player);
    await player.getByRole("button", { name: "End session" }).click();
    await expect(player.getByTestId("session")).toHaveCount(0);
    expect(host).toBeTruthy();
    expect(playerErrors).toEqual([]);
    expect(friendErrors).toEqual([]);
  });

  test("without a relay, says plainly that watching is not available", async ({
    browser,
    baseURL,
    request,
  }) => {
    test.skip(Boolean(E2E_TURN_URL), "a relay is configured: the test above watches through it");
    test.setTimeout(120_000);
    const { player, friend, playerErrors, friendErrors } = await playerPlays(browser, baseURL!, request);
    await friend.reload();
    const line = friend.getByTestId("crew-live-line");
    await expect(line).toContainText("is playing", { timeout: 30_000 });
    await line.getByRole("button", { name: "Ask to watch" }).click();
    await expect(friend.getByTestId("watch-wait")).toContainText("Watching isn't available here yet");
    // The player is never asked, and no connection is made to anyone for it.
    await expect(player.getByTestId("crew-asks")).toHaveCount(0);
    expect(await friend.evaluate(() => (window as unknown as { __kept: unknown[] }).__kept.length)).toBe(0);
    await wakeHud(player);
    await player.getByRole("button", { name: "End session" }).click();
    expect(playerErrors).toEqual([]);
    expect(friendErrors).toEqual([]);
  });
});
