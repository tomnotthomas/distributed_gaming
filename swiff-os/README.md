# Swiff OS

Swiff OS is the rental mode for host PCs: a locked Linux system that a host PC boots into while it is
shared. The renter's Steam session runs on an immutable, measured OS that the owner has no admin rights
on. The design is in the rental-mode report (§5–§8, staged plan in §11). This directory is built up
stage by stage.

| Directory   | What it is                                                                         |
| ----------- | ---------------------------------------------------------------------------------- |
| `image/`    | The mkosi build of the Swiff OS image (stage 1)                                    |
| `vm/`       | The VM test: builds the image and boots it under Secure Boot with a TPM            |
| `streamer/` | `swiff-streamer`: gamescope's picture and sound to the renter, their input back in |
| later       | `hostd/` (session agent), attestation client                                       |

## Server: hosting requires attestation

The server side lives in `server/`, not here: `server/src/attestation.ts`. A machine's rights
are split in two. The machine key, which stays in the owner's host app, keeps the control
rights. A short-lived host certificate, which `swiff-hostd` earns by attestation, gets the
hosting rights: `session-claimed`, session keys and TURN credentials.

`HOSTING_ATTESTATION=required` switches an environment to attested-only hosting. The default,
`optional`, keeps today's desktop hosts working at an explicit `unattested` tier. The verifier
is an interface: `tpm` (`server/src/tpm-verifier.ts`) for production, and the `insecure-dev`
stub for VMs and tests. The contract is in
[`docs/system-design/session-keys.md`](../docs/system-design/session-keys.md), "Control and
hosting credentials".

## Host app: preflight, install and switch

The owner's side lives in `desktop/`: `desktop/rental.cjs` reads, without administrator
rights, what Swiff OS needs from the PC (UEFI, Secure Boot, TPM 2.0, IOMMU, disk space,
BitLocker, graphics card, Fast Startup), and the Rental mode screen
(`desktop/src/screens/Rental.tsx`) shows it with the BIOS steps the owner must take by hand.
The Secure Boot db and the TPM's endorsement certificate need administrator rights, so they
show as not checked yet. The install (shrink a drive or use free space, add the partitions,
write the ESP, add the boot entry, name the games drive `SWIFFGAMES`, queue Swiff's key as a
MOK and restart once to confirm it) and the start/stop sharing switch (BootOrder and BootNext)
are previews: the app plans them and runs nothing on a PC. Real PCs boot Swiff OS through a
Linux distribution's Microsoft-signed shim, which trusts Swiff's key once the owner confirms it
at MokManager's blue screen, with a one-time code the host app shows and guides them through.
A missed screen enrols nothing, and the owner confirms again from the host app.
`desktop/vm/rental-install-test.sh` carries the plans out on a disk image and boots it under
OVMF with Secure Boot and a software TPM; `desktop/vm/mok-enroll-test.sh` boots Ubuntu's signed
shim under OVMF with Microsoft's keys and confirms the app's MOK request at MokManager, after a
miss and then with the code.

## Stage 1: the image

`image/` builds a bootable disk image with mkosi 20. It is Ubuntu 26.04 LTS ("resolute"), pinned to a
dated snapshot of the archive (`Mirror=` in `image/mkosi.conf`), with a fixed `SourceDateEpoch` and
partition seed. The build tools (`ukify`, `sbsign`, `systemd-repart`, `mkfs.erofs`) come from a tools
tree of the same release, not from the build host.

### Boot chain

The firmware starts systemd-boot, which starts a Unified Kernel Image (UKI). systemd-boot and the UKI
are signed for Secure Boot. The UKI holds the kernel, the initrd and the kernel command line. The
command line carries the dm-verity root hash, so the UKI pins every byte of the root filesystem.
systemd-stub measures the UKI's sections into PCR 11. While Secure Boot is on, it ignores any command
line passed from outside. The VM test checks that PCR 11 equals the value `systemd-measure` predicts for
the built UKI. That value is what the attestation verifier will expect (report §5.3, stage 3).

### Disk layout

The layout is a fixed 23.6 GiB, inside the ~24 GB budget of decision D6. The owner is not offered a
size choice.

| Partition      | Size    | Contents                                                           |
| -------------- | ------- | ------------------------------------------------------------------ |
| ESP            | 1 GiB   | systemd-boot and the signed UKI                                    |
| root, slot A   | 8 GiB   | read-only erofs root under dm-verity, labelled `swiffos_<version>` |
| root-verity, A | 128 MiB | its dm-verity hash tree                                            |
| root, slot B   | 8 GiB   | empty (`_empty`), for the next version                             |
| root-verity, B | 128 MiB | empty (`_empty`)                                                   |
| scratch        | 6.4 GiB | per-boot encrypted scratch: `/home` and the games overlay's writes |

The A/B slots follow systemd-sysupdate's conventions. A UKI finds its own root by UUID, because
systemd-repart derives the root and hash partition UUIDs from the root hash. An update writes a new
root and hash into the empty slot and adds a UKI that points at them. The old slot stays bootable until
the new one has booted well. The update service itself (signed `systemd-sysupdate`) is stage 5.

### What runs

- **The root is read-only.** erofs is mounted through dm-verity, and `/var` is a tmpfs
  (`systemd.volatile=state`).
- **The scratch partition is erased by every reboot.** At each boot, `/etc/crypttab` opens it as plain
  dm-crypt under a key read from `/dev/urandom`. The key is never stored, and a new ext4 is made on it.
  A reboot is therefore a cryptographic erase. `/home` lives there, so the renter's Steam login and
  data are gone after a reboot.
- **The renter user is unprivileged.** `renter` (uid 1000) has no password, no login shell, no sudo and
  no supplementary groups. The root has no setuid or setgid programs at all.
- **The session is the whole UI.** `swiff-session.service` runs gamescope with Steam on tty1 as
  `renter`, with `NoNewPrivileges`. It starts only after `nftables.service` has loaded the firewall
  and does not start at all if loading fails. There is no display manager, desktop, getty, serial
  console login or sshd.
- **The keyboard reaches nothing but the session.** Ctrl+Alt+Del never reboots:
  `ctrl-alt-del.target` is masked, and `CtrlAltDelBurstAction=none` turns off systemd's forced
  reboot after 7 presses within 2 s. Alt+Up (`kbrequest.target`) is masked too. Before the session
  starts, `swiff-vtlock.service` makes tty1 the active VT and locks VT switching (`VT_LOCKSWITCH`)
  until the next boot, so Ctrl+Alt+Fn, Alt+Fn and Alt+Left/Right do nothing, and neither does a
  program's or logind's `VT_ACTIVATE`. The session does not start without the lock. No getty runs on
  any VT. This stands behind the streamer's own key filter.
- **The LAN is blocked.** nftables (`/etc/nftables.conf`) refuses traffic to RFC 1918, link-local,
  multicast and broadcast addresses, their IPv6 counterparts, every on-link prefix and the prefix of
  each of the host's own global addresses, so the LAN's global IPv6 addresses (even when the router
  advertises the prefix without an on-link route) and non-RFC 1918 LANs (such as CGNAT 100.64.0.0/10)
  are blocked too.
  Programs fail at once rather than waiting for a timeout (IPv4: "No route to host", IPv6:
  "Permission denied"). It allows DHCP, IPv6
  neighbour discovery and multicast listener (MLD) reports, and DNS to the current gateway and DNS servers. `swiff-netguard` keeps the
  gateway, DNS and on-link sets current. The gateway is reachable for DNS and ping only, not for its admin pages. Internet traffic
  is allowed.
- **The shared games library is read-only.** It is mounted read-only at `/srv/games-lower`, with an
  overlay at `/srv/games` whose writes go to the scratch. The VM stubs it with a small ext4 disk
  labelled `SWIFFGAMES`. Verifying it and promoting verified updates is stage 4.
- **The kernel is hardened from the signed command line.** It runs with `lockdown=confidentiality`,
  `module.sig_enforce=1`, a forced strict IOMMU, no hibernation, no USB mass storage and
  `systemd.import_credentials=no`. The last one means credentials and units cannot be injected from
  the ESP, SMBIOS or the firmware. Through sysctl it also runs with Yama `ptrace_scope=3`, kexec
  disabled and SysRq off.

### Provisional settings for open decisions

`/usr/lib/swiff/rental-policy.conf` is the one place for two decisions that are still open:

- **D3, hardware floor:** UEFI, Secure Boot, TPM 2.0 with an EK certificate, and an IOMMU. Discrete TPMs
  are accepted at a lower trust tier.
- **D8, owner takeover:** "Return to Windows" only when the PC is idle.

`swiff-hwcheck` checks the parts of D3 that Swiff OS can see on its own at boot, and writes the verdict
to `/run/swiff/hardware-floor`. The EK certificate and the TPM tier are checked by attestation (stage 3).

## Building and testing

The test runs in a VM only. It never touches the host's disks, boot entries or UEFI variables. It
needs `sudo` (mkosi 20 builds as root), QEMU/KVM, OVMF, swtpm and bubblewrap. If the user has no
access to `/dev/kvm`, QEMU is started through `sudo` and drops back to the user (`-runas`) before the
VM starts.

```sh
swiff-os/vm/run-test.sh             # build the test image, boot it twice, check everything
swiff-os/vm/run-test.sh --no-build  # boot the last build again
# the shipped image only, as swiffos.raw in the given output directory
sudo mkosi -C swiff-os/image --output-dir ~/.cache/swiff-os/output --cache-dir ~/.cache/swiff-os/cache build
```

Build output, caches and the VM's disk copy and logs go to `$SWIFF_OS_BUILD_DIR` (default `~/.cache/swiff-os`), outside the
source tree. The build runs as root, and the root-only directories it leaves would break tools that
walk the repository, such as `prettier --check .`. The first build downloads about 2 GB and takes
a while; later builds reuse the caches. If `image/mkosi.key` and `image/mkosi.crt` do not exist, the test makes a
throwaway Secure Boot key pair there. The key pair is git-ignored and for VMs only.

`run-test.sh` builds the `selftest` profile. That is the shipped image plus a serial console and
`swiff-selftest.service` (`vm/selftest/`). The test then boots the image twice in QEMU, with 2 GiB of
RAM and 2 vCPUs, under OVMF with Secure Boot and swtpm:

1. **Boot 1.** The firmware starts in setup mode. systemd-boot enrols the test certificate as PK, KEK
   and db, and resets the VM. The signed UKI then boots with Secure Boot enforcing.
2. **Boot 2.** A cold boot of the same disk, firmware variables and TPM.

The self-test reports each check on the serial console, and the script adds the checks that need the
host's view. Together they cover:

- Secure Boot is on and enforcing.
- The kernel runs with lockdown and module signature enforcement.
- The IOMMU is on, and the hardware floor passes.
- The UKI was measured, and PCR 11 equals the `systemd-measure` prediction.
- The root is the verity device, bound to the UKI's root hash, and refuses writes. The booted slot is
  slot A, and slot B is present.
- The renter user is unprivileged, with no shell and no password. Root is locked, and there is no
  sudo and no setuid binary.
- The session is gamescope with Steam as `renter`, and no login of any kind is offered.
- Keys pressed on the VM's keyboard through QEMU's monitor do nothing: 10 Ctrl+Alt+Del within
  2 s reach systemd and neither reboot the VM nor queue a reboot, and Ctrl+Alt+F2, Alt+F2,
  Alt+Left/Right and Alt+Up leave tty1 active, as does `VT_ACTIVATE` as root. As a control,
  Ctrl+Alt+F2 does switch to tty2 once the lock is lifted.
- The LAN is blocked for the renter, including the host's address in an on-link global IPv6 prefix,
  also after its on-link route is deleted (a SLAAC prefix advertised without the on-link flag),
  while DNS and the internet work. As a control, the same LAN service and IPv6 address answer once
  the firewall is removed.
- The scratch is encrypted: the renter's marker never appears in the partition's raw bytes. It is
  re-keyed and empty after the reboot, and the games overlay forgets the renter's writes.
- The disk image fits the 24 GiB budget.

The VM has no GPU, so gamescope cannot start there and the session unit keeps restarting. The test
checks the session's wiring, not a running game.

## Follow-ups (not in stage 1)

- **Shim and MOK in the image.** Real PCs boot through a distribution's Microsoft-signed shim, with
  Swiff's key enrolled once as a MOK (the host app queues it and guides the confirmation). The image
  does not ship the shim yet; the VM enrols the test key directly instead. Swiff's own
  Microsoft-signed shim is deferred.
- **Steam client persistence.** The Steam client's runtime is downloaded into the ephemeral `/home` on
  first start of each boot. It moves to the sealed state partition with attestation (stage 3).
- **Starting the game directly.** Driving Steam's QR login from Swiff's own screen and launching the
  game straight away, so the renter never sees Steam's UI, is a Stage 0 spike plus the session agent.
- **Steam's sandbox.** Ubuntu's AppArmor restriction on unprivileged user namespaces may need a Steam
  profile for pressure-vessel. This can only be tested with a GPU.
- **NVIDIA.** Modules must be signed for `module.sig_enforce`, for example Ubuntu's prebuilt signed
  NVIDIA modules. Redistribution terms need checking.
- **The `-security` pocket.** mkosi 20 always uses the live `security.ubuntu.com` for it. Pinning it
  too needs a newer mkosi or a local mirror.

## swiff-streamer

The Linux streamer (report §5.2): it captures the gamescope session through PipeWire,
encodes it to H.264 (NVENC or VA-API on the GPU, x264 in software where there is
none, as in a VM), and serves it to the renter over the existing Swiff WebRTC
protocol. The renter's keyboard, mouse and controllers come back over the protocol's
two input channels and are injected through uinput. The renter's browser sees the
same host it sees today: the same signaling, the same SDP shape (one stream, H.264
and stereo Opus), the same `input-keys` and `input-motion` channels.

```
   swiff-hostd (root) ──fork as swiff-stream, grant on stdin──► swiff-streamer (Node)
                                                                 │  @swiff/rtc: signaling, ICE inbox,
   renter (uid 1000)                                             │  input protocol and receiver
   ├─ gamescope ── PipeWire node "gamescope" ──┐                 │  werift: the peer connection
   └─ PipeWire socket (ACL: swiff-stream rw) ◄─┴── swiff-gst.py ─┤  RTP framed on stdout (RFC 4571)
                                                   swiff-uinput.py ◄─ input events, fixed records
                                                   └─► /dev/uinput: keyboard, mouse, pointer, pads
```

- **Its own user.** It runs as `swiff-stream` (uid 961, `system/swiff-streamer.sysusers`),
  never as the renter, because it holds the session key. swiff-hostd starts it once per
  renter session and hands it the key as one JSON line on stdin
  (`{"sessionKey": "...", "expiresAt": <Unix s>}`); its environment carries only
  `SWIFF_SERVER_URL` and `SWIFF_HOST_ID` (hostd's `SWIFF_APPID` is ignored). `SWIFF_SERVER_URL`
  must be `wss://` unless it points at this machine (loopback), so the session key never
  crosses the network in the clear; only a test may override that (`--insecure-signaling`,
  as the VM test does). It registers with the session key, never sees the machine key, and exits whenever the server puts it out (session
  ended, or the key refused after a reconnect); swiff-hostd decides what follows.
- **Capture.** `helpers/swiff-gst.py` runs the GStreamer pipelines `src/pipeline.ts`
  builds: `pipewiresrc target-object=gamescope` → scale → H.264 Constrained Baseline,
  no B-frames, a keyframe every 4 s and whenever the renter's decoder sends a PLI →
  `rtph264pay` (MTU 1200), and the session's sound (the default sink's monitor) as
  stereo Opus. Each pipeline writes length-framed RTP to the helper's stdout, so no local
  port takes packets from anyone else. A frame the encoder cannot take yet is dropped,
  never queued. The encoder is picked at start: NVENC, then VA-API, then x264, the first
  that encodes a few test frames cleanly. A pipeline that stops (gamescope restarting) is
  started again; the picture is ready before the renter connects. If no picture has come
  within 30 s of start (gamescope's node is missing), the streamer exits with 1 instead
  of leaving the renter on a black screen.
- **The renter's PipeWire.** The streamer connects to the renter's PipeWire socket
  (`--pipewire-remote`). `system/swiff-pipewire-grant` (a user unit in the renter's own
  manager) lets `swiff-stream` connect to that socket and pass through the renter's
  runtime directory, and nothing else. The renter cannot reach the streamer.
- **Input.** `src/uinputEvents.ts` is the input receiver's sink: it maps keys by
  `KeyboardEvent.code` (layout-independent), relative and absolute mouse, wheel and up
  to four controllers (an Xbox 360 layout, so Steam Input and SDL map them untaught) to
  Linux input events. `helpers/swiff-uinput.py` replays them on virtual devices it makes
  through `/dev/uinput`, which only the `swiff-stream` group may open
  (`system/70-swiff-streamer.rules`). The receiver lets go of everything held when the
  renter blurs, disconnects or falls silent for a second. Keys that act on the PC rather
  than the game (Power, Sleep, PrintScreen, which is SysRq) are never sent, and the sink
  drops Ctrl+Alt+Delete and the console switches (Alt+F<n>, Ctrl+Alt+F<n>,
  Alt+Left/Right). The devices
  carry `phys=swiff-streamer`, tagged `SWIFF_STREAMER=1` by udev, so the image can ignore
  every other input device during a session.

```bash
npm test -w @swiff/os-streamer         # unit tests, and one against the real server (build it first)
npm run build -w @swiff/os-streamer    # dist/swiff-streamer.mjs, one file, werift included
swiff-os/streamer/vm/run-test.sh       # the VM test (below)
```

**For the image.** Install `dist/swiff-streamer.mjs` and `helpers/` side by side (for
example `/usr/lib/swiff/streamer/dist/` and `/usr/lib/swiff/streamer/helpers/`), and
`system/` as sysusers, tmpfiles, udev rule, `/usr/libexec/swiff/swiff-pipewire-grant` and
the renter's user unit. It needs Node 22, Python 3 with GObject introspection, GStreamer
1.24 or later (base, good, bad, ugly, PipeWire) and `acl`. swiff-hostd's `streamer`
setting is then `{"command": "/usr/bin/node", "args":
["/usr/lib/swiff/streamer/dist/swiff-streamer.mjs", "--pipewire-remote",
"/run/user/1000/pipewire-0"], "uid": 961, "gid": 961}`. `--help` lists the other
options: picture size, frame rate, bitrate, encoder, a test source.

**The VM test.** `vm/run-test.sh` builds a small Ubuntu 24.04 test image with mkosi
(not Swiff OS; only what the streamer needs), boots it in QEMU/KVM with 2 GiB and 2
vCPUs, and plays one renter session through it. The host runs the real server (in
memory) and a real renter, headless Chromium on the real `/rtc` page; the VM runs the
renter's PipeWire with a synthetic `gamescope` node and a test tone, and an agent that
starts the streamer exactly as swiff-hostd does. It checks: the user separation
(the renter cannot open `/dev/uinput`, the streamer cannot read the renter's home), the
PipeWire grant, x264 chosen with no GPU, picture and sound flowing, the renter decoding
1280×720 and playing it, the renter's key, click and pointer arriving as kernel input
events on the virtual devices, Ctrl+Alt+Delete, Ctrl+Alt+F3 and Alt+F4 never arriving
while plain F2, Delete, Ctrl and Alt do, the streamer exiting cleanly when the
session ends, and the PipeWire grant applied again when `pipewire.socket` makes a new
socket. The run passes only when every check passes and the VM powers itself off
within `$SWIFF_VM_TIMEOUT` seconds (default 600). In the last run all 25 checks passed:
the streamer was registered 1.2 s after start and the renter decoded the first frame
2.3 s after pressing Connect (x264, 720p30, no GPU). The VM runs Node.js's own Linux
build, pinned by version and checksum and downloaded once into the build directory. It waits while another VM runs or the PC has under 4 GB free, never touches the host's
disks, boot entries or firmware, and needs `sudo` for mkosi (and for QEMU when this
user cannot open `/dev/kvm`). Build output goes to `$SWIFF_STREAMER_BUILD_DIR`
(default `~/.cache/swiff-os-streamer`); `--build-only` builds without starting a VM, and
`--no-build` reruns the last build. The renter's Chromium needs its system libraries;
where they are missing, point `LD_LIBRARY_PATH` at extracted copies.

**Deviations from the report, and why.**

- **werift, not GStreamer's `webrtcbin`.** The peer connection is werift's, a WebRTC stack
  in TypeScript, fed RTP the GStreamer helpers already encoded. That keeps the protocol
  code shared with the desktop host and the renter (`@swiff/rtc`'s signaling client, ICE
  inbox, input protocol and receiver) instead of a second implementation in another
  language. `webrtcbin` stays the fallback if werift's throughput falls short on real
  hardware.
- **No adaptive bitrate yet.** The video is constant bitrate (10 Mbit/s by default, the
  desktop host's ceiling); nothing changes the encoder's bitrate at runtime yet. Adapting
  it to the renter's bandwidth estimate is a follow-up.
- **Physical input and outputs off during a session** (report §5.2) belong to the image
  and swiff-hostd; the streamer only tags its own devices so they can tell.

**Open decisions.** Two are still open; each is one setting in swiff-hostd and the
image, not in the streamer, and the streamer works under either:

- **D3, hardware floor** (provisional: UEFI, Secure Boot, TPM 2.0 with an EK certificate,
  IOMMU; discrete TPMs at a lower trust tier).
- **D8, owner takeover** (provisional: the owner gets the PC back only while it is idle).

**Follow-ups (real hardware, Stage 0).** The VM has no GPU, so these wait for the owner's
PC: NVENC and VA-API at 1080p60 with the real gamescope (and zero-copy DMA-BUF from
PipeWire to the encoder), gamescope's headless or virtual-output mode taking uinput
devices, the time from Play to first frame, Steam Input taking the virtual controllers,
controller rumble (force feedback back to the renter), and werift's CPU cost at 10–20
Mbit/s.
