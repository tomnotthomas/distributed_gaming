# distributed_gaming

Swiff — rent an idle gaming PC and play it in a browser.

Phase 1 is the connection only: a Windows PC streams its screen to a renter's browser.
Plan: [`docs/phase-1/plan.md`](docs/phase-1/plan.md).

## Run it

```bash
npm install
npm run dev          # builds the web app, serves it, runs signaling on :8080
```

- `http://localhost:8080` — the renter
- `http://localhost:8080/host` — the gaming PC

Open both, click **Start sharing** on `/host`, then **Connect** on `/`.

```bash
npm test             # unit + integration tests (server and web)
npm run test:e2e     # end-to-end: real browsers, real peer connection
npm run typecheck    # app, tests and e2e specs
npm run ci           # everything CI runs, in the same order
npm run dev:web      # vite dev server with HMR (signaling must run separately)
```

## Tests

| Layer | Where | What it covers |
|---|---|---|
| Unit | `web/src/*.test.ts(x)` | ICE candidate selection, signaling reconnect/backoff, the status line |
| Integration | `web/src/integration/` | The browser's signaling client against a real server process |
| Integration | `server/src/test/` | The relay itself, driven through raw sockets |
| End-to-end | `e2e/tests/web.*` | Two browsers, a real peer connection, decoded frames arriving |
| End-to-end | `e2e/tests/desktop.*` | The Electron host app captures the screen with nobody there to approve it |

The Electron specs skip themselves until `desktop/` exists on the branch, so they
light up on their own when the host app lands instead of sitting red until then.
Point them at a build elsewhere with `SWIFF_DESKTOP_DIR=/path/to/desktop`.

**Running the browser e2e locally on macOS:** the application firewall drops the
inbound UDP that ICE connectivity checks need, so the streaming test fails on
about half of local runs. Either allow Chromium under System Settings → Network →
Firewall, or trust CI, where there is no such filter.

## Reading the status line

Both pages show the connection state and which ICE candidate won:

| | Meaning |
|---|---|
| `host` | Same local network. **Says nothing about the internet path.** |
| `srflx` | Direct across the internet via STUN. The good case. |
| `relay` | Going through TURN. Working, and costing bandwidth. |

Two machines on the same wifi will connect as `host` and prove nothing. To test for real,
tether the renter to a phone — carrier CGNAT is symmetric NAT, which is exactly the case
TURN exists for.

## Layout

```
server/src/          TypeScript. Node + ws — static files and signaling relay. No database.
server/src/protocol.ts   The wire format. Imported by the web app too, so it is defined once.
web/src/             Vite + React. Routes / (renter) and /host (gaming PC).
docs/                Plan and architecture diagrams.
```

Both packages are TypeScript and strict. `npm run typecheck` checks both without building.
