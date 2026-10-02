// Where a game's art comes from. The windows load no remote content, so it is
// never Steam's CDN: on this PC it is the copy Steam keeps locally, served by
// main as swiff-art://<appid>/<kind> (pc.cjs); in the demo it is art bundled
// with the app.

import { createContext } from "react";

/** A game's pictures, top layer first: each shows wherever the ones above it are missing. */
export type ArtSource = (appid: number) => string[];

/** The key art Steam keeps on this PC, with its store header under it. */
export const localArt: ArtSource = (appid) => [`swiff-art://${appid}/hero`, `swiff-art://${appid}/header`];

export const ArtContext = createContext<ArtSource>(localArt);
