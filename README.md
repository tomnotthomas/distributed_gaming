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
cp .env.example .env              # then set ROOM_SECRET
npm run machine-key -- gaming-pc-1   # key for the host app, entry for MACHINE_KEYS
```

## Renter side (web app + server)

```bash
npm run dev       # builds web/, serves it and signaling on :8080
npm run dev:web   # vite with HMR, run signaling separately with npm start
```

A renter joins with the ticket `POST /api/bookings/:id/claim` returns, or a link from
`npm run ticket -- gaming-pc-1`.

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
