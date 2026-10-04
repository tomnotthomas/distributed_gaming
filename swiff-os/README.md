# Swiff OS (rental mode)

Rental mode is a separate, locked Linux system a host PC boots into while its owner
shares it. Renters play there, never on the owner's Windows, and the PC restarts clean
between renters. Steam runs with Proton in a gamescope session as an unprivileged
renter user. The system runs from a dm-verity root, boots from a Swiff-signed Unified
Kernel Image, and is measured into the TPM, so the server can check it before it sends
a renter. The owner's Windows host app stays the control centre: "Start sharing" reboots
the PC into rental mode, and it stays there while it is shared.

It is built in stages, each a small PR. This directory holds what is built so far:

| Part     | What it is                                                                                  |
| -------- | ------------------------------------------------------------------------------------------- |
| `hostd/` | `swiff-hostd`, the agent that connects the PC to the platform and runs the renter sessions. |

Still to come: the image (mkosi, A/B verity root, UKI), the Linux streamer and its input,
attestation and the disk-key release, games-drive verification, the status page, and the
host app's install and switch flow.

## swiff-hostd

The rental-mode agent: a root systemd service (`hostd/swiff-hostd.service`), and the
"PC service" of [`session-keys.md`](../docs/system-design/session-keys.md). It speaks the
host protocol the desktop app already speaks, with no new messages
([`host.md`](../docs/system-design/host.md) §5, `server/src/protocol.ts`).

- **Holds the machine key; the streamer never sees it.** The key is in a file only root
  can read. For each renter session the agent gets a 5-minute session key
  (`POST /api/machines/:id/session`) and hands it to the streamer on stdin. The streamer
  runs as its own unprivileged user. Its environment carries only `SWIFF_SERVER_URL`,
  `SWIFF_HOST_ID` and `SWIFF_APPID`.
- **One renter at a time.** While the PC is offered, the agent holds the room with the
  machine-key socket and hears `session-claimed`. It then starts that session's host
  session and the streamer. It sends a heartbeat every 5 s, and learns the session is
  over when the heartbeat stops naming it. A streamer that stops mid-session is started
  again with a fresh key. After 4 failed starts the agent ends the session.
- **Restarts clean after every renter, while nobody waits (D5).** When a session ends,
  the agent first takes the PC off offer (`available: false`, with the owner's share-until
  sent back), so no renter is matched to a PC that is about to restart. It then ends the
  host session and reboots. On the way back up it offers the PC again on the same terms.
  It keeps a small `resume.json` in its state directory to remember that it took the PC
  off offer itself.
- **Goes back to Windows** when the owner asks at the PC, when the owner stops sharing
  from elsewhere, or when the share-until passes. It puts Windows Boot Manager first in
  the firmware boot order and reboots.
- **On boot**, it first ends any host session a crash left behind. A session still live
  is served at once, with a new key.

Two open decisions are each one setting in `hostd/src/config.ts`, with provisional
defaults:

- **D8 `OWNER_TAKEOVER`** (`"when-idle"`). The owner gets the PC back only while no
  session is live; a request during a session is refused. Set it to `"always"` to end
  the session as the owner taking the machine back.
- **D3 `HARDWARE_FLOOR`.** The agent does not offer the PC unless it has UEFI, Secure
  Boot on, a TPM 2.0 and an IOMMU. The server's verifier, in the attestation stage, judges
  the TPM's EK certificate and the lower trust tier for a discrete TPM.

```bash
npm test -w @swiff/hostd                  # unit tests, and one against the real server (build it first)
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts      # the agent
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts status
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts return-to-windows
```

The agent runs as TypeScript source on Node 22.18 or later, using Node's own type
stripping, so there is no build step. The config format is in
`hostd/hostd.example.json`. `status` and `return-to-windows` talk to the running agent
over its control socket, which only root can use.

**Not yet here.** These come in later stages:

- The end-of-session steps that come before the reboot: wait for Steam Cloud, upload
  saves that are not in Steam Cloud, log Steam out.
- Re-attesting before each session.
- A host certificate in place of the machine key.
- Holding the PC back until its games are verified.
- A server-side hold that keeps a resetting PC from being matched. Today a renter who
  claims the PC in the instant its last session ends is served after the restart, about
  30 s later.
