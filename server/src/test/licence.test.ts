// Bring your own games without the network: the library is built by hand and
// the store's fetch is stubbed, so these pin who may play what, not Steam.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetCatalog } from "../catalog.js";
import { storeFreeToPlay, unlicensed } from "../licence.js";
import { emptyProfile, ownsApp, pageProfile, type SteamProfile } from "../steam.js";

const ID = "76561198000000001";
const ELDEN_RING = 1245620;
const CS2 = 730;

/** A profile whose library Steam showed, holding `appids`. */
const libraryOf = (...appids: number[]): SteamProfile => ({
  ...emptyProfile(ID),
  lib: true,
  library: Uint32Array.from(appids).sort(),
});

const paidOnly = async () => false;
const everythingFree = async () => true;

describe("ownsApp", () => {
  it("finds every appid in the library and nothing else", () => {
    const profile = libraryOf(570, 10, 2073850, 730, 1245620);
    for (const appid of [10, 570, 730, 1245620, 2073850]) assert.equal(ownsApp(profile, appid), true);
    for (const appid of [0, 9, 11, 1091500, 2 ** 31 - 1]) assert.equal(ownsApp(profile, appid), false);
    assert.equal(ownsApp(emptyProfile(ID), 730), false);
  });

  it("is never sent to the page", () => {
    const shown = pageProfile(libraryOf(730));
    assert.equal("library" in shown, false);
    assert.equal(JSON.stringify(shown).includes("library"), false);
  });
});

describe("unlicensed", () => {
  it("lets a renter play a paid game in their library", async () => {
    assert.equal(await unlicensed(libraryOf(ELDEN_RING), ELDEN_RING, paidOnly), null);
  });

  it("lets anyone play a free-to-play game, library read or not", async () => {
    assert.equal(await unlicensed(libraryOf(), ELDEN_RING, everythingFree), null);
    assert.equal(await unlicensed(emptyProfile(ID), ELDEN_RING, everythingFree), null);
  });

  it("refuses a paid game that is not in a library Steam showed", async () => {
    assert.equal(await unlicensed(libraryOf(CS2), ELDEN_RING, paidOnly), "not-owned");
  });

  it("refuses a paid game when the library cannot be read, as the wall does", async () => {
    assert.equal(await unlicensed(emptyProfile(ID), ELDEN_RING, paidOnly), "library-unreadable");
  });

  it("falls back to the curated free-to-play titles when the free check fails", async () => {
    const failing = async () => {
      throw new Error("store down");
    };
    assert.equal(await unlicensed(emptyProfile(ID), CS2, failing), null);
    assert.equal(await unlicensed(emptyProfile(ID), ELDEN_RING, failing), "library-unreadable");
  });
});

describe("storeFreeToPlay", () => {
  const realFetch = globalThis.fetch;
  beforeEach(resetCatalog);
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The store answering GetItems with `items`. */
  const storeAnswers = (items: object[]) => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ response: { store_items: items } }),
    })) as unknown as typeof fetch;
  };
  const item = (appid: number, free: boolean) => ({
    appid,
    visible: true,
    type: 0,
    name: "G",
    is_free: free,
  });

  it("takes the store's word on whether a game is free", async () => {
    storeAnswers([item(ELDEN_RING, false), item(CS2, true), item(440, true)]);
    const isFree = storeFreeToPlay();
    assert.equal(await isFree(ELDEN_RING), false);
    assert.equal(await isFree(440), true);
  });

  it("uses the curated free-to-play titles when the store does not answer in time", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const isFree = storeFreeToPlay(20);
    assert.equal(await isFree(CS2), true);
    assert.equal(await isFree(ELDEN_RING), false);
  });

  it("uses the curated free-to-play titles when the store fails", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const isFree = storeFreeToPlay();
    assert.equal(await isFree(2073850), true);
    assert.equal(await isFree(ELDEN_RING), false);
  });
});
