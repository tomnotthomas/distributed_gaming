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

Code: `web/`, `server/`, `packages/`.

## Host side (gaming PC app)

```bash
npm run desktop        # run the Electron app locally
npm run desktop:demo   # the same app on labelled demo data, to walk every screen
npm run desktop:pack   # build desktop/release/SwiffHost-<version>.exe
```

Code: `desktop/`, `packages/`.

## Rental mode (Swiff OS)

The locked Linux system a shared PC boots into, built in stages: [`swiff-os/`](swiff-os/README.md).

## Checks

```bash
npm test
npm run test:e2e
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
