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

## The gaming PC runs the Electron app

`/host` in a browser needs a human to click Chrome's "Share this screen" dialog. A rental
machine has nobody sitting at it, so the real host is `desktop/` — an Electron app whose
main process answers that request in code via `setDisplayMediaRequestHandler`.

Build a Windows executable (works from macOS or Linux; electron-builder fetches wine):

```bash
npm run desktop:pack      # → desktop/release/SwiffHost-<version>.exe
```

Copy that one file to the Windows machine and run it. Nothing else gets installed there —
no node, no repo, no build step. It asks for one thing: the signaling server's address.

```bash
npm run desktop           # run it locally instead, for development
```

Because the app is not served by the signaling server, it cannot read the address off
`location` the way the web pages do. Paste the host (`something.trycloudflare.com`) or a
full URL; `ws://` and `wss://` are inferred from the scheme, defaulting to `wss://`.

## Getting the signaling server onto the internet, for free

The gaming PC and the renter both need to reach the same server, and Chromium refuses
`getDisplayMedia` outside a secure context — so plain `http://<lan-ip>` will not work.
A free Cloudflare quick tunnel gives HTTPS and wss with no account and no domain:

```bash
npm run dev                                   # signaling on :8080
cloudflared tunnel --url http://localhost:8080
```

It prints a random `https://<name>.trycloudflare.com`. Paste that into the Electron app,
and open the same URL in the renter's browser. The 25s ping in `packages/rtc/signaling.ts`
exists for exactly this path: Cloudflare closes an idle WebSocket after 100 seconds.

Note that phase 1 has no auth and one hardcoded room, so anyone holding the URL can join
it. Fine for a test between two machines you own, wrong for anything else.

## Layout

```
packages/ui/         Component library and design tokens, shared by web and desktop.
                     Tokens are copied from prototypes/tokens/ — keep them in sync.
packages/rtc/        Signaling client, peer helpers, and the host half of the handshake.
server/src/          TypeScript. Node + ws — static files and signaling relay. No database.
server/src/protocol.ts   The wire format. Imported by the clients too, so it is defined once.
web/src/             Vite + React. Routes / (renter) and /host (browser host, for dev).
desktop/             Electron. The gaming PC's host app. Bundles to a Windows .exe.
docs/                Plan and architecture diagrams.
```

Everything is TypeScript and strict. `npm run typecheck` checks server and web without
building.

`web/` and `desktop/` render the same components against the same tokens, so the renter
page and the host app are the same product rather than two that happen to share a repo.
