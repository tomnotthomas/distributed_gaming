// The HTTP surface of the signaling server, exercised over a real socket.
//
// Any extensionless path is the same SPA and everything with an extension is a
// file off disk, which is a small enough rule that it is easy to break without
// noticing — especially the part where a crafted path must not escape the build
// directory.

import { expect, test } from "@playwright/test";

test.describe("static serving", () => {
  test("serves the app at the renter route", async ({ request }) => {
    const res = await request.get("/");

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
  });

  test("serves the same app at every route", async ({ request }) => {
    const wall = await request.get("/");

    // One bundle, several routes — the page decides which screen to render.
    for (const route of ["/host", "/rtc", "/share"]) {
      const res = await request.get(route);
      expect(res.status(), route).toBe(200);
      expect(await res.text(), route).toBe(await wall.text());
    }
  });

  test("serves the built bundle with a javascript content type", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const src = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(src, "index.html should reference a built bundle").toBeTruthy();

    const res = await request.get(src!);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("javascript");
  });

  test("404s an asset that does not exist", async ({ request }) => {
    const res = await request.get("/assets/nope-does-not-exist.js");

    expect(res.status()).toBe(404);
  });

  test("does not serve files from outside the build directory", async ({ request }) => {
    // Both the encoded and the plain form, because only one of them survives
    // URL normalisation and the guard has to hold for whichever arrives.
    for (const path of [
      "/%2e%2e/%2e%2e/package.json",
      "/..%2f..%2fpackage.json",
      "/%2e%2e%2f%2e%2e%2fserver/package.json",
    ]) {
      const res = await request.get(path);

      expect(res.status(), `${path} must not be served`).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain('"name": "swiff"');
    }
  });
});
