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
npm run machine-key -- gaming-pc-1 <owner-steam-id>   # key for the host app, entry for MACHINE_KEYS
```

## Renter side (web app + server)

```bash
npm run dev       # builds web/, serves it and signaling on :8080
npm run dev:web   # vite with HMR, run signaling separately with npm start
```

A renter signs in with Steam, which sets their session cookie, then books and joins with
the ticket `POST /api/bookings/:id/claim` returns. For testing, `npm run ticket -- gaming-pc-1`
makes a join link without a booking.

`npm run seed-requirements` fills the server database (`DATABASE_PATH`) with each catalogue
game's minimum and recommended hardware, read from Steam; `server/src/requirements-overrides.json`
overrides it per game.

Code: `web/`, `server/`, `packages/`.

## Host side (gaming PC app)

```bash
npm run desktop        # run the Electron app locally
npm run desktop:pack   # build desktop/release/SwiffHost-<version>.exe
```

Code: `desktop/`, `packages/`.

## Checks

```bash
npm test
npm run test:e2e
npm run typecheck
npm run format    # Prettier; CI runs format:check
npm run ci        # everything CI runs
```

Push branches with `git push no-mistakes <branch>` (after `no-mistakes init`): it reviews, tests and lints
the branch first, then pushes to origin and opens the PR. Config: `.no-mistakes.yaml`.
