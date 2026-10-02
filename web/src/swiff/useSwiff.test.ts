import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GAMES } from "./data";
import type { Renter } from "./steam";
import { useSwiff } from "./useSwiff";

// Analytics are off in tests; the real module refuses to load without a key in dev.
vi.mock("../posthog", () => ({ default: { capture: () => {} }, isPostHogEnabled: false }));

/** What /api/me answers without a Steam Web API key: the session's Steam id, an empty profile. */
const unnamed: Renter = {
  steamId: "76561198000000001",
  profile: { id: "0001", persona: "", avatar: "", hours: 0, size: 0, owned: [], games: [], lib: false },
};

/** The server: /api/me answers `renter` (404 when null); every catalog read comes back empty. */
function serve(renter: Renter | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path === "/api/me" && renter
        ? new Response(JSON.stringify(renter), { status: 200 })
        : new Response("{}", { status: 404 }),
    ),
  );
}

/** A free-to-play game with a machine free tonight, so only sign-in can stand in its way. */
const cs2 = GAMES.find((game) => game.id === "cs")!;

describe("useSwiff", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads signed in from the session even when Steam gave no name", async () => {
    serve(unnamed);
    const { result } = renderHook(() => useSwiff());

    await waitFor(() => expect(result.current.signedIn).toBe(true));
    expect(result.current.steamId).toBe(unnamed.steamId);
    expect(result.current.profile?.persona).toBe("");
  });

  it("will not launch for a signed-out visitor", async () => {
    serve(null);
    const { result } = renderHook(() => useSwiff());
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/me"));

    act(() => result.current.openGame(cs2));
    expect(result.current.picked).not.toBeNull();
    act(() => result.current.launch());

    expect(result.current.signedIn).toBe(false);
    expect(result.current.phase).toBe("idle");
  });

  it("launches for a signed-in renter", async () => {
    serve(unnamed);
    const { result } = renderHook(() => useSwiff());
    await waitFor(() => expect(result.current.signedIn).toBe(true));

    const game = result.current.games.find((g) => g.appid === cs2.appid)!;
    act(() => result.current.openGame(game));
    act(() => result.current.launch());

    expect(result.current.phase).toBe("connecting");
  });
});
