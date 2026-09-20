# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web.streaming.spec.ts >> host to renter streaming >> reports which ICE path won, so a green light can be trusted
- Location: e2e/tests/web.streaming.spec.ts:108:7

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.status')
Expected substring: "connected"
Received string:    "failed · unknown no candidate pair selected yet"
Timeout: 30000ms

Call log:
  - Expect "toContainText" locator('.status') with timeout 30000ms
  - waiting for locator('.status')
    2 × locator resolved to <p class="status">…</p>
      - unexpected value "new · unknown no candidate pair selected yet"
    32 × locator resolved to <p class="status">…</p>
       - unexpected value "connecting · unknown no candidate pair selected yet"
    30 × locator resolved to <p class="status">…</p>
       - unexpected value "failed · unknown no candidate pair selected yet"

```

```yaml
- paragraph:
  - strong: failed
  - text: ·
  - strong: unknown
  - text: no candidate pair selected yet
```

# Test source

```ts
  20  | async function fakeScreenCapture(page: Page) {
  21  |   await page.addInitScript(() => {
  22  |     const canvas = document.createElement("canvas");
  23  |     canvas.width = 1280;
  24  |     canvas.height = 720;
  25  |     const ctx = canvas.getContext("2d")!;
  26  | 
  27  |     let frame = 0;
  28  |     setInterval(() => {
  29  |       frame += 1;
  30  |       ctx.fillStyle = `hsl(${(frame * 9) % 360} 70% 45%)`;
  31  |       ctx.fillRect(0, 0, canvas.width, canvas.height);
  32  |       ctx.fillStyle = "#fff";
  33  |       ctx.font = "96px sans-serif";
  34  |       ctx.fillText(String(frame), 60, 400);
  35  |     }, 60);
  36  | 
  37  |     const stream = (canvas as HTMLCanvasElement & {
  38  |       captureStream(fps?: number): MediaStream;
  39  |     }).captureStream(30);
  40  | 
  41  |     // Host applies width/frameRate constraints after the fact; a canvas track
  42  |     // rejects those, and the rejection would be reported as a capture failure.
  43  |     for (const track of stream.getVideoTracks()) {
  44  |       track.applyConstraints = async () => {};
  45  |     }
  46  | 
  47  |     navigator.mediaDevices.getDisplayMedia = async () => stream;
  48  |   });
  49  | }
  50  | 
  51  | /** Fail loudly on a page error rather than letting it surface as a timeout. */
  52  | function failOnPageError(page: Page, label: string) {
  53  |   const errors: string[] = [];
  54  |   page.on("pageerror", (err) => errors.push(`${label}: ${err.message}`));
  55  |   return errors;
  56  | }
  57  | 
  58  | test.describe("host to renter streaming", () => {
  59  |   test("carries the host's screen to the renter's video element", async ({ browser }) => {
  60  |     const hostCtx = await browser.newContext();
  61  |     const renterCtx = await browser.newContext();
  62  |     const host = await hostCtx.newPage();
  63  |     const renter = await renterCtx.newPage();
  64  | 
  65  |     const hostErrors = failOnPageError(host, "host");
  66  |     const renterErrors = failOnPageError(renter, "renter");
  67  | 
  68  |     await fakeScreenCapture(host);
  69  | 
  70  |     await host.goto("/host");
  71  |     await expect(host.getByRole("heading", { name: "Gaming PC" })).toBeVisible();
  72  |     await host.getByRole("button", { name: "Start sharing" }).click();
  73  | 
  74  |     // The host registers and then waits; nobody has joined yet.
  75  |     await expect(host.getByText("Waiting for a renter…")).toBeVisible();
  76  | 
  77  |     await renter.goto("/");
  78  |     await expect(renter.getByRole("heading", { name: "Swiff" })).toBeVisible();
  79  |     await renter.getByRole("button", { name: "Connect" }).click();
  80  | 
  81  |     // Each side learns about the other through the signaling server.
  82  |     await expect(host.getByText("A renter is connected.")).toBeVisible();
  83  | 
  84  |     // ICE completed and DTLS came up on both ends.
  85  |     await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });
  86  |     await expect(host.locator(".status")).toContainText("connected", { timeout: 30_000 });
  87  | 
  88  |     // And frames are genuinely decoding, not just a negotiated-but-silent track.
  89  |     await expect
  90  |       .poll(
  91  |         () => renter.locator("video.stream").evaluate((v: HTMLVideoElement) => v.videoWidth),
  92  |         { timeout: 30_000, message: "renter never received a decoded frame" },
  93  |       )
  94  |       .toBeGreaterThan(0);
  95  | 
  96  |     const playedSeconds = await renter
  97  |       .locator("video.stream")
  98  |       .evaluate((v: HTMLVideoElement) => v.currentTime);
  99  |     expect(playedSeconds, "video should be playing, not parked at 0").toBeGreaterThan(0);
  100 | 
  101 |     expect(hostErrors).toEqual([]);
  102 |     expect(renterErrors).toEqual([]);
  103 | 
  104 |     await hostCtx.close();
  105 |     await renterCtx.close();
  106 |   });
  107 | 
  108 |   test("reports which ICE path won, so a green light can be trusted", async ({ browser }) => {
  109 |     const hostCtx = await browser.newContext();
  110 |     const renterCtx = await browser.newContext();
  111 |     const host = await hostCtx.newPage();
  112 |     const renter = await renterCtx.newPage();
  113 | 
  114 |     await fakeScreenCapture(host);
  115 |     await host.goto("/host");
  116 |     await host.getByRole("button", { name: "Start sharing" }).click();
  117 |     await renter.goto("/");
  118 |     await renter.getByRole("button", { name: "Connect" }).click();
  119 | 
> 120 |     await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });
      |                                             ^ Error: expect(locator).toContainText(expected) failed
  121 | 
  122 |     // Both peers are the same machine, so this is a loopback `host` pair. The
  123 |     // point of the assertion is that the status line resolves it at all rather
  124 |     // than sitting on "unknown" — that is what makes a real srflx/relay run
  125 |     // readable later.
  126 |     await expect(renter.locator(".status")).not.toContainText("unknown", { timeout: 20_000 });
  127 |     await expect(renter.locator(".status")).toContainText(/host|srflx|relay|prflx/);
  128 | 
  129 |     await hostCtx.close();
  130 |     await renterCtx.close();
  131 |   });
  132 | 
  133 |   test("tells the renter the gaming PC is offline when nothing is sharing", async ({ page }) => {
  134 |     await page.goto("/");
  135 |     await page.getByRole("button", { name: "Connect" }).click();
  136 | 
  137 |     await expect(page.getByText(/gaming PC is offline/)).toBeVisible();
  138 |   });
  139 | 
  140 |   test("tells the renter when the host disappears mid-session", async ({ browser }) => {
  141 |     const hostCtx = await browser.newContext();
  142 |     const renterCtx = await browser.newContext();
  143 |     const host = await hostCtx.newPage();
  144 |     const renter = await renterCtx.newPage();
  145 | 
  146 |     await fakeScreenCapture(host);
  147 |     await host.goto("/host");
  148 |     await host.getByRole("button", { name: "Start sharing" }).click();
  149 |     await renter.goto("/");
  150 |     await renter.getByRole("button", { name: "Connect" }).click();
  151 |     await expect(renter.locator(".status")).toContainText("connected", { timeout: 30_000 });
  152 | 
  153 |     // The gaming PC goes away without saying goodbye.
  154 |     await hostCtx.close();
  155 | 
  156 |     await expect(renter.getByText(/gaming PC disconnected/)).toBeVisible({ timeout: 20_000 });
  157 | 
  158 |     await renterCtx.close();
  159 |   });
  160 | 
  161 |   test("the host shows nothing is captured until sharing starts", async ({ page }) => {
  162 |     await fakeScreenCapture(page);
  163 |     await page.goto("/host");
  164 | 
  165 |     await expect(page.locator(".status")).toContainText("not capturing");
  166 |     await expect(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
  167 |   });
  168 | });
  169 | 
```