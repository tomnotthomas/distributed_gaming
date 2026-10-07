# distributed_gaming

Lanterel (formerly Swiff): rent an idle gaming PC and play it in a browser. Code identifiers
(`swiff-os/`, `@swiff/*`, `web/src/swiff/`) keep the old name.

Owners install a small host app on their Windows gaming PC. Renters pick a game on the
website, get matched to a free PC, and play it over a WebRTC stream straight from that
machine. The server only brokers the connection; the video and input go peer to peer.
When the session ends, the PC goes back to its owner.

System design: [renter](docs/system-design/renter.md), [host](docs/system-design/host.md).

## Setup

```bash
npm install
cp .env.example .env              # then set ROOM_SECRET and SESSION_SECRET
# Steam sign-in also needs PUBLIC_ORIGIN (e.g. https://swiff.example) in .env when
# NODE_ENV=production; without it every sign-in is refused. Elsewhere it defaults to
# http://localhost:$PORT.
# Set STEAM_API_KEY (https://steamcommunity.com/dev/apikey) too, or a signed-in renter's
# Steam name and game library stay empty and only free-to-play games can be booked.
npm run machine-key -- gaming-pc-1 <owner-steam-id>   # key for the host app, entry for MACHINE_KEYS
```

The server keeps its data in Postgres at `DATABASE_URL` (a Neon connection string works as
given) and makes its tables on start. Without it, the data lives in memory and is gone when
the server stops, which is fine for local dev.

## Renter side (web app + server)

```bash
npm run dev       # builds web/, serves it and signaling on :8080
npm run dev:web   # vite with HMR, run signaling separately with npm start
```

A renter signs in with Steam, which sets their session cookie, then books and joins with
the ticket `POST /api/bookings/:id/claim` returns. For testing, `npm run ticket -- gaming-pc-1`
makes a join link without a booking.

`npm run seed-requirements` fills the server database (`DATABASE_URL`) with each catalogue
game's minimum and recommended hardware, read from Steam; `server/src/requirements-overrides.json`
overrides it per game.

Renters are shown, and may book, only games Lanterel can run (`server/src/playable.ts`). The server
checks each game by fixed rules against Steam's store data, Valve's SteamOS rating and
AreWeAntiCheatYet, on its own and daily, and demotes a game whose launches keep failing. The one
hand-kept input is whether a publisher allows or objects to cloud play, per game in the same
overrides file (`cloud`, with the evidence in `cloudWhy`). A game that asks for an account besides
Steam's at start (Ubisoft Connect, the EA app, Battle.net, Rockstar…) stays playable: the catalog
names its launcher (`requiresAccount`), and the game page tells the renter they will sign in to it.

A signed-in player founds a crew in one tap (`/crews/new`) and shares its link
(`/invite/<token>`); anyone in a crew may share it, and anyone in it brings a gaming PC now
or later. A PC plays for the crews its owner picks, and only for the people in them. See
[Crews](docs/system-design/renter.md#crews). A host also keeps up to four named seats at their
PC for friends, from the host app; a friend takes one from its link (`/seat/<token>`) and plays
their own games there. See [Friend seats](docs/system-design/renter.md#friend-seats).

A crewmate can ask to watch a player's session, view only, and talk with them in a voice
chat; the player says yes over the game and can stop anyone. The player's page streams it
on, so the gaming PC uploads nothing more. See
[Watching a crewmate play](docs/system-design/renter.md#watching-a-crewmate-play).

Code: `web/`, `server/`, `packages/`.

## Marketing site

The public launch pages, under the product's new name Lanterel (`server/src/brand.ts`, the one place
it is set), live in `web/marketing/`, imported from marketing's built set with
`node server/scripts/import-launch-pages.mjs <built set>`; the server reads them when it starts, so
an import takes effect on its next start (every deploy). The same server serves them, off unless
`MARKETING_PAGES=on`, and then only on the host `SITE_ORIGIN` names, so the app keeps its own `/`,
`/share` and `/host`.

Signing up is signing in with Steam: there is no sign-up form. "Crew gründen" and every other button
on the pages goes to Steam sign-in on the app's origin and back to the app's crew pages (`/crews`),
which found a crew at once for a player who has none yet and show the PC card first to someone from
the host page. A crew link or friend seat the site is given (`/crew/<code>`, `/seat/<code>`) goes on to
the app's own invite page (`/invite/<token>`, `/seat/<token>`), which names who asks; those app links
also get a link preview naming them (`server/src/invite-preview.ts`). Gift seats and Zockrunden
(`/gift/`, `/night/`) do not exist yet, so their pages name nobody. The set's wording for a crew's
time together ("Crew-Abend", "crew night") is put the app's way at import ("Zockrunde", "gaming
session"), never an evening or a night. The product asks for no email address and sends no mail. See
`server/src/marketing.ts`.

Settings (server environment):

- `MARKETING_PAGES=on` turns the pages on. Leave it off until the bracketed
  placeholders in the Impressum and legal notice (the founder's name, address and contact, e.g.
  `[VOR- UND NACHNAME]`) are filled in.
- `SITE_ORIGIN`, e.g. `https://lanterel.de`: the site's own origin. The pages are served only to
  requests for its host, and it is the origin in the pages' canonical and Open Graph links.
  Without it the pages stay off even with `MARKETING_PAGES=on`.
- `PUBLIC_ORIGIN`, the app's own origin (Steam sign-in needs it too): every link on the pages into the
  app, such as "Crew gründen" and "Prüf deine Bibliothek", goes there. Without it the pages stay off
  as well.

## Host side (gaming PC app)

```bash
npm run desktop        # run the Electron app locally
npm run desktop:demo   # the same app on labelled demo data, to walk every screen
npm run desktop:pack   # build desktop/release/LanterelHost-<version>.exe
```

The download page (`/share`) publishes the SHA-256 of the installer and of the Lanterel OS image
set as text, to check with `Get-FileHash` before running it. The release step writes them:
CI's package job leaves `SHA256SUMS` beside each installer, `swiff-os/image-set.sh` beside the
image set, and `node desktop/checksums.cjs release web/src/swiff/release.json --host <exe>
--url <address> --image <set>` puts them, with the download's address, on the page.

Code: `desktop/`, `packages/`.

## Rental mode (Lanterel OS)

The locked Linux system a shared PC boots into, built in stages: [`swiff-os/`](swiff-os/README.md).
Remove Lanterel OS takes one click to start and one confirmation on a blue screen during a restart;
the app then finishes on its own (Windows may ask once more for permission).

## Checks

```bash
npm test
npm run test:e2e
npm run test:e2e:relay   # the stream through TURN alone; needs coturn (e2e/relay/run.sh)
npm run typecheck
npm run format    # Prettier; CI runs format:check
npm run ci        # everything CI runs
```

The server tests run on PGlite, Postgres in memory, unless `TEST_DATABASE_URL` names a real
one, as in CI. Each test gets a schema of its own there:

```bash
docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test -w @swiff/server
```

Push branches with `git push no-mistakes <branch>` (after `no-mistakes init`): it reviews, tests and lints
the branch first, then pushes to origin and opens the PR. Config: `.no-mistakes.yaml`.
