# Step 5 — input

**Goal:** the renter drives the machine. Mouse, keyboard and gamepad from the browser,
injected on Windows.

This is step 5 of [`plan.md`](./plan.md) — _"the step that makes it a gaming product rather
than a screen viewer"_.

Steps 1–4 and 6 are done: the Electron host streams 1080p60 to a browser across the public
internet. **Audio shipped separately and is no longer planned work** — Windows loopback
capture, a second sender, and the Opus stereo munge in `packages/rtc/src/opus.ts`. What is
left of that here is the part input has yet to learn from it: SDP that has to be edited by
hand, and a fallback for when the edit is refused.

---

## Why the spike comes before the work

Input has one genuine unknown sitting under it — whether an Electron app can inject
OS-level input into a fullscreen game at all — and everything else in step 5 is ordinary
work that is wasted if the answer is no.

**Spike the injection question before writing any of the rest.**

---

## What gets built

| Piece           | What it is                                       | Where it runs          |
| --------------- | ------------------------------------------------ | ---------------------- |
| Input capture   | Pointer lock, key up/down, Gamepad API           | Renter page            |
| Input channels  | Two `RTCDataChannel`s with different reliability | `packages/rtc`         |
| Input injection | Win32 `SendInput` through an FFI binding         | Host app, main process |
| Kill switch     | Host takes the machine back, instantly           | Host app               |

---

## Input

### The spike, before anything else

**Electron cannot do this on its own.** `webContents.sendInputEvent` injects into the Electron
window; a fullscreen game never sees it. OS-level synthetic input is required.

| Route                       | Cost                                                                |
| --------------------------- | ------------------------------------------------------------------- |
| `koffi` + Win32 `SendInput` | Prebuilt binaries, no node-gyp, no rebuild step                     |
| `nut-js`                    | Native addon; `npmRebuild: false` in the build config has to change |
| `robotjs`                   | Effectively unmaintained                                            |

Prefer `koffi`: it calls `SendInput` directly and avoids dragging a native build into an
electron-builder pipeline that currently and deliberately does not have one.

**Acceptance for the spike:** from inside the _packed_ app, move the cursor and press a key
in a fullscreen game, and watch the game react. Not a text editor — a game. Fullscreen
exclusive mode, anti-cheat-free title, on this machine. If that does not work, the rest of
this section is void and the answer is a different capture architecture, not a different
library.

### Steps, once the spike passes

1. **Two channels, not one.** Mouse deltas are worthless once stale, key events are not:

   ```ts
   pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 });
   pc.createDataChannel("keys", { ordered: true });
   ```

   A dropped mouse delta is a nudge nobody notices. A dropped `keyup` is a key held down
   forever. They do not belong on the same channel.

2. **Create them before the offer.** A data channel added after `setLocalDescription`
   renegotiates, and phase 1 has no renegotiation path.

3. **Capture in the renter.** Pointer lock for `movementX/Y`; `getCoalescedEvents()` so a
   high-polling-rate mouse is not decimated to the frame rate; `event.code`, never
   `event.key`, so a German keyboard sends the same scancode as a US one.

4. **Inject on the host.** Relative `MOUSEEVENTF_MOVE`, not absolute — absolute positioning
   breaks every game that captures the cursor. Scancodes over virtual key codes for the
   same layout reason.

5. **Kill switch.** Stop sharing already ends the session; input must stop at the same
   instant, and a held key must be released rather than left down.

### Fails silently if omitted

```
event.code not event.key        // layout independence; `key` is what the layout produced
preventDefault() on keydown     // or the browser eats WASD-adjacent shortcuts
keyup for every held key        // on pointerlock exit, blur, visibilitychange, channel close
MOUSEEVENTF_MOVE relative       // absolute coordinates break cursor-captured games
bufferedAmount check            // a saturated channel queues input into next week
```

The stuck-key case is the one that will reach a user first: alt-tab while holding W, and the
character walks into a wall until the session ends.

### What the browser will not give you

Pointer lock and fullscreen get most of the keyboard, but not all of it. `Ctrl+W`, `Cmd+Tab`,
`Alt+F4` and the Windows key stay with the OS and the browser. There is no fix — decide
which in-game bindings that rules out and say so, rather than letting players discover it.

### Verification

1. **Latency, measured not felt.** Timestamp each input, have the host echo the sequence
   number back on the reliable channel, and record the round trip in the status line. This
   is the number the product lives or dies on; do not leave it to impressions.
2. **Stuck-key test.** Hold a key, alt-tab, come back. Nothing should still be pressed.
3. **Thirty minutes, with a gamepad.** Analogue sticks generate far more traffic than a
   mouse and are where `bufferedAmount` backpressure shows up first.

---

## What input costs on a relayed path

Nothing measurable. Input is a handful of kilobits next to a 10 Mbit video stream, and a
data channel rides the same transport the media already negotiated — a session that reaches
the renter at all can carry its keyboard.

The TURN cost that does matter is video's, and `plan.md`'s Risks section now carries the
corrected figures.

---

## Not in scope

- Host isolation. Still phase 2, and input makes it matter more — see Risks.
- Clipboard, file transfer, multi-monitor selection.
- Audio _from_ the renter. Voice chat is a different feature with a different latency budget.
- macOS hosting. No loopback audio, no `SendInput`.
- Renegotiation. Channels and tracks are fixed at offer time in phase 1.

---

## Risks

**Screen capture plus input injection is the behavioural signature of a RAT.** Antivirus
heuristics and SmartScreen will treat the app accordingly, and the artifact is currently
unsigned with the default Electron icon. Code signing moves from "nice before launch" to a
blocker for anyone who is not you — budget for a certificate before asking a stranger to
install this.

**A renter now drives the owner's actual desktop.** Until host isolation lands, input turns
"they can see my screen" into "they can use my computer" — every saved password, every
signed-in session. Phase 1 is explicitly meant to run on machines with nothing private on
them; with input, that stops being a precaution and becomes the only thing standing between
a host and a bad afternoon.

**Latency becomes visible.** Video delay is tolerable; input delay is not, and the same
connection that looked fine as a stream may feel wrong the moment a cursor is attached to
it. Measure it in step 5's verification rather than discovering it in a demo.

---

## Open questions

- Does input stay on while the host is watching, or does the host's presence pause the
  session? Related to the kill switch, and it decides whether hosting is passive income or a
  thing you supervise.
- Gamepad passthrough is a real device emulation problem (ViGEm) rather than synthetic
  input. Decide whether phase 1 sends gamepads as emulated keyboard, or not at all.
