# distributed_gaming

Swiff: rent an idle gaming PC and play it in a browser.

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

Renters are shown, and may book, only games Swiff can run (`server/src/playable.ts`). The server
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

Code: `web/`, `server/`, `packages/`.

## Host side (gaming PC app)

```bash
npm run desktop        # run the Electron app locally
npm run desktop:demo   # the same app on labelled demo data, to walk every screen
npm run desktop:pack   # build desktop/release/SwiffHost-<version>.exe
```

The download page (`/share`) publishes the SHA-256 of the installer and of the Swiff OS image
set as text, to check with `Get-FileHash` before running it. The release step writes them:
CI's package job leaves `SHA256SUMS` beside each installer, `swiff-os/image-set.sh` beside the
image set, and `node desktop/checksums.cjs release web/src/swiff/release.json --host <exe>
--url <address> --image <set>` puts them, with the download's address, on the page.

Code: `desktop/`, `packages/`.

## Rental mode (Swiff OS)

The locked Linux system a shared PC boots into, built in stages: [`swiff-os/`](swiff-os/README.md).
Remove Swiff OS takes one click to start and one confirmation on a blue screen during a restart;
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
