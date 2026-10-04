# Swiff OS

Swiff OS is the rental mode for host PCs: a locked Linux system that a host PC boots into while it is
shared. The renter's Steam session runs on an immutable, measured OS that the owner has no admin rights
on. The design is in the rental-mode report (§5–§8, staged plan in §11). This directory is built up
stage by stage.

| Directory   | What it is                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| `image/`    | The mkosi build of the Swiff OS image (stage 1)                                      |
| `vm/`       | The VM test: builds the image and boots it under Secure Boot with a TPM              |
| `streamer/` | `swiff-streamer`: gamescope's picture and sound to the renter, their input back in   |
| `hostd/`    | `swiff-hostd`: connects the PC to the platform and runs one renter session at a time |
| later       | attestation client                                                                   |

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
A missed screen enrols nothing: shim then shows a security error and the PC falls back to
Windows, and the owner chooses Confirm the security key again on the Rental mode screen, which
queues the same request with a new code and restarts once more (a preview too). The app does
not read yet whether the key is enrolled: reading MokListRT is a follow-up for the install
executor.
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
`SignExpectedPcr=yes` (in `image/mkosi.conf`) signs those expected PCR 11 values with the Secure Boot
key into the UKI's `.pcrsig`, with the public key in `.pcrpkey`. systemd copies both to `/run/systemd`
at boot, and `swiff-hostd` seals the state partition's U share under that signed policy. `.pcrsig` is
not itself measured, so the PCR 11 prediction is the same.

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
- **The renter sees only verified games.** The owner's games library is never written by the renter.
  The renter sees a view of it at `/srv/games` that shows only verified files, and their writes go to
  a per-boot encrypted session layer. See [Stage 4](#stage-4-the-shared-games-library).
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

## Stage 4: the shared games library

The owner's existing Steam library drive is shared with rental mode (report §8). It is usually NTFS
and written by the owner's Windows, so rental mode trusts none of it as it stands.
`swiff-games.service` runs `/usr/libexec/swiff/verify` (`swiff-verify`). It finds the volume labelled
`SWIFFGAMES` and the Steam library on it.

### The verified table

`SwiffOS/verified-games.json` on the library volume holds, per game, the SHA-256, size and mtime of
every file in Steam's depot manifests, its folders, the manifests' own hashes, a cleaned copy of
Steam's app manifest, and the files present but not in the manifests ("extras"). It also records the
TPM `resetCount` and `restartCount` of the last rental-mode boot. It is authenticated with an HMAC whose
key is sealed to the TPM under PCR 7 (`systemd-creds`, `SwiffOS/table-key.cred`). The owner's Windows
can delete the table, which costs a new bootstrap, but cannot forge it.

The key is created only when there is none. If it no longer unseals, for example after a Secure Boot
update changed PCR 7, rental mode tries three times, then keeps the credential and blocks every game.
The report's `table` field tells the host app that the owner must bootstrap the games again. That
bootstrap is the only thing that seals a new key: the new table then holds just the games it validated.

### At every boot

- **The check.** Every TPM power-up adds one to `resetCount`. If it is exactly one more than at the
  last rental-mode boot and `restartCount` is 0, no other OS has run, and each file only has its size
  and mtime compared. Any other value means the owner's Windows or a live USB may have run, and every
  file of every game is hashed again. An OS that hibernates, as Windows does with Fast Startup, keeps
  `resetCount` but leaves `restartCount` above 0. Games that fail are **blocked**:
  - a verified file is missing or its content changed;
  - a new program file appeared in the game's folder: an `.exe`, `.dll` or `.so`, or any file that
    starts like one. It is hidden either way; blocking it marks the tampering.

  A blocked game stays marked in the table and is hashed in full at every boot until it passes or the
  owner bootstraps it again. A quick check alone would miss a same-size edit that kept the mtime.
- **The games report.** `/run/swiff/games-report.json` lists each game as `verified`, `blocked` (with
  the reason) or `not-bootstrapped`, which is a game on the library that rental mode has not
  validated. This is the installed-games report (report §8.4).
- **The renter's view.** `/srv/games` is an overlay. Above the library sits a layer of whiteouts that
  hides everything not in the table:
  - blocked and unvalidated games, and their app manifests;
  - extras, such as a dropped DLL or the owner's mods;
  - changed UserConfig files (the game's own settings, which Steam does not restore);
  - depot manifests not in the table;
  - anything that is not a game.

  Verified games get their app manifest from the table. Overlay redirects, metacopy and index are
  off, so overlay xattrs that another OS writes on the drive are never followed.

- **The session layer.** The renter's writes land in a file on the library volume,
  `SwiffOS/session.img`. It takes half of the volume's free space, and always leaves the owner 5% of
  the volume (at most 8 GiB). ext4 keeps it sparse; `ntfs3` allocates it in full, without writing it,
  while rental mode runs. The other half stays free, so that an update the session layer holds fits
  onto the library when it is promoted. A drop-in for `swiff-games.service` can change the share with
  `Environment=SWIFF_GAMES_SESSION_SHARE=<percent>`. It is deleted at shutdown. It is opened with plain dm-crypt under a random key that is never stored
  and formatted fresh. Like the scratch partition, a reboot erases it cryptographically, and the
  owner's Windows sees only ciphertext. Game updates, shader caches and Proton prefixes use the
  library's space, not the small Swiff OS partition (D6).
- **NTFS libraries.** overlayfs cannot keep its writes on NTFS, but it can on ext4 inside a file on
  NTFS. The volume is mounted with the kernel's `ntfs3`, readable and writable by root only. Every
  file shows as the renter's, so that Steam can update games through the view. If the volume only
  mounts read-only, for example when Windows left it hibernated, the session layer falls back to the
  scratch partition and nothing is promoted.

### Bootstrap, sealing and promotion

Steam's own UI lets whoever is at it start programs (launch options, non-Steam games), and a game can
run code too. Both run as the renter, who can write into the view. So only what Steam writes **before**
anything the user drives has started can be trusted:

1. **Bootstrap**, once per shared game. The owner signs in to Steam inside rental mode with a QR code.
   `swiff-verify view --bootstrap` shows the library as the owner left it, but hides Steam's cached
   depot manifests, which the owner's Windows wrote. Steam then has to fetch them from Valve while it
   validates the games (`steam://validate/<appid>`) and repairs them into the session layer.
   `swiff-verify seal --bootstrap APPID...` checks every file against those manifests:
   - SHA-1 against the manifest, recording SHA-256;
   - encrypted file names are decrypted with Steam's depot key;
   - extras are recorded and stay hidden.

   Steam's validation alone is not enough, because it ignores extra files.

2. **Updates.** The renter's Steam updates a game before the game starts. `swiff-verify seal APPID`
   checks the result: Steam must report it fully installed, and every file must match the manifests
   Steam fetched in this boot. A depot whose manifest is unchanged is checked against the table.
3. **`swiff-verify close-seal`** runs before anything the user drives starts. Afterwards nothing can
   be sealed in this boot. `swiff-session.service` runs it at start, because the Stage 1 session is
   Steam's own UI. The session agent will call it just before it launches the game.
4. **Promotion** runs at shutdown (`ExecStop`), after the session has stopped, so it fits the reboot
   between renters (D5). For each sealed game, the files that the session layer still holds
   **byte-identical** to what was sealed are copied onto the library. The table and Steam's app
   manifest are then updated, the manifest without the renter's SteamID. One changed file keeps the
   whole update off the library. The game is marked `promoting` while its files are renamed into
   place, and an interrupted promotion is fully re-hashed at the next boot. An update that does not
   fit in the library's free space (plus 64 MiB) is not promoted, and the reason is logged; the game
   stays on its verified version. Nothing half-written is left on the library.

Only games the owner bootstrapped get updates: a renter cannot add games to the owner's library.

## Building and testing

The test runs in a VM only. It never touches the host's disks, boot entries or UEFI variables. It
needs `sudo` (mkosi 20 builds as root), QEMU/KVM, OVMF, swtpm and bubblewrap. If the user has no
access to `/dev/kvm`, QEMU is started through `sudo` and drops back to the user (`-runas`) before the
VM starts.

```sh
swiff-os/vm/run-test.sh             # build the test image, boot it seven times, check everything
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
`swiff-selftest.service` (`vm/selftest/`). In the test build the session starts only after the
self-test, so sealing stays open, as it would until a game is launched. The test then boots the
image seven times in QEMU, with 2 GiB of RAM and 2 vCPUs, under OVMF with Secure Boot and swtpm:

1. **Boot 1.** The firmware starts in setup mode. systemd-boot enrols the test certificate as PK, KEK
   and db, and resets the VM. The signed UKI then boots with Secure Boot enforcing. The owner
   bootstraps four games.
2. **Boot 2.** A cold boot of the same disk, firmware variables and TPM. The renter's Steam updates
   three games, and the session changes one of them after sealing.
3. **Boot 3.** Only the update that still verified is on the library.
4. **A firmware-only boot** stands in for the owner's Windows, after the host plants a DLL in one game
   and changes a file of another, keeping its size and mtime.
5. **Boot 4.** The full re-hash blocks both games.
6. **Boot 5.** No other OS booted, so the check is quick, and both games stay blocked.
7. **Boot 6.** The host damages the table key's credential, as if it no longer unsealed. Every game is
   blocked, the credential is kept, and the owner bootstraps one game, which seals a new key.
8. **Boot 7.** The same disk with an ext4 library.

Before it builds, the script runs `vm/test_verify.py`, host-side tests of `swiff-verify`'s decisions on
plain folders, with the TPM and `systemd-creds` stood in for. They cover a TPM restart after a
hibernated OS, the session layer's size, an update that does not fit on the library or whose copy is
cut short, a block that must survive the next quick check, and a table key that does not unseal. Run
them alone with `python3 swiff-os/vm/test_verify.py`.

The games library comes from `vm/games-fixture.py`. It writes a 512 MiB NTFS library through
`ntfs-3g` from the build's tools tree, and the ext4 copy. Its five games carry Steam-format depot
manifests, one with encrypted file names. A small fixture disk tells the self-test which boot it is
in and what Steam would write; `vm/selftest/usr/libexec/swiff/selftest-games` plays Steam's part as
the renter. The host also needs `python3-cryptography`.

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
  re-keyed and empty after the reboot.
- The games library, on NTFS and ext4:
  - Nothing is offered before bootstrap.
  - The session layer is an encrypted file on the library, and the renter's marker never appears in
    the NTFS image's raw bytes. The renter cannot reach the volume.
  - The bootstrap seals four games with Steam's fresh manifests, including encrypted file names. The
    fifth is refused, because its only manifest is the one the owner's Windows left.
  - Steam's repair reaches the library.
  - The view hides the owner's planted DLL, mods, changed settings file, unvalidated game and old
    manifest.
  - A good update is sealed. An update that does not match its manifest is refused, and so is a
    game that was never bootstrapped. Sealing is refused once closed.
  - Only the good update is promoted, onto the NTFS library as Windows reads it. Its app manifest
    keeps the owner's SteamID. An update the session changed after sealing is not promoted.
  - Without a `resetCount` gap the check is quick. After the firmware-only boot it is a full
    re-hash, and the planted DLL and the changed file each block their game and hide it. Both stay
    blocked at the next quick boot, also after the view is mounted again.
  - The session layer leaves at least as much of the library free as it can hold.
  - A table key that does not unseal blocks every game and is kept, until the owner's bootstrap
    seals a new one.
- The disk image fits the 24 GiB budget.

The VM has no GPU, so gamescope cannot start there and the session unit keeps restarting. The test
checks the session's wiring, not a running game.

## Follow-ups

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
- **Games: the session agent drives sealing.** The agent runs Steam without its UI, lets it update
  the game, calls `seal`, then `close-seal`, then launches the game. For bootstrap it drives Steam's
  validation instead. Until then, the shipped image closes sealing when the session starts, so it
  never promotes.
- **Games: the table's home.** The table moves into the sealed state partition, under a signed PCR 11
  policy, with attestation (stage 3). The PCR 7 policy survives OS updates but does not tell two
  boot chains signed by the same key apart.
- **Games: offering games one by one.** The view is mounted once every game is checked. Offering
  each game as it passes a long re-hash needs the agent to remount the view between sessions.
- **Games: a drive changed while the PC is off.** A drive taken out and edited in another PC leaves
  no `resetCount` gap. Size, mtime and new program files are still checked, but a same-size edit
  that keeps the mtime is caught only by the next full re-hash.
- **Games: shader caches.** Shader caches and Proton prefixes live in the session layer, on the
  library's space, but are not kept across renters. No manifest can verify them.
- **Games: Stage 0 checks with real Steam.** Still to confirm with a real Steam client:
  - Steam fetches manifests again when depotcache is empty;
  - its depotcache format;
  - where its depot keys live;
  - which files it marks UserConfig.

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

## swiff-hostd

The rental-mode agent: a root systemd service (`hostd/swiff-hostd.service`), and the
"PC service" of [`session-keys.md`](../docs/system-design/session-keys.md). It speaks the
host protocol the desktop app already speaks, with no new messages
([`host.md`](../docs/system-design/host.md) §5, `server/src/protocol.ts`).

- **Holds the machine key; the streamer never sees it.** The key is in a file root owns
  and only root can read (mode 600); the agent refuses any other. For each renter
  session the agent gets a 5-minute session key (`POST /api/machines/:id/session`) and
  hands it to the streamer on stdin. The streamer runs as its own unprivileged user. Its
  environment carries only `SWIFF_SERVER_URL`, `SWIFF_HOST_ID` and `SWIFF_APPID`.
- **One renter at a time.** While the PC is offered, the agent holds the room with the
  machine-key socket and hears `session-claimed`. It then starts that session's host
  session and the streamer. It sends a heartbeat every 5 s, and learns the session is
  over when the heartbeat stops naming it. A streamer that stops mid-session is started
  again with a fresh key. After 4 starts in a row that each stop within a minute, the agent
  ends the session.
- **Restarts clean after every renter, while nobody waits (D5).** When a session ends,
  the agent first takes the PC off offer (`available: false` with `reset: true`, and the
  owner's share-until sent back), so no renter is matched to a PC that is about to
  restart. That is the server's reset hold ([`host.md`](../docs/system-design/host.md)):
  a renter who claimed the PC in the instant before, even after the agent's last
  heartbeat, is kept and held through the restart, and served once the PC is back. It
  then ends the host session and reboots. On the way back up it offers the PC again on the same terms.
  It keeps a small `resume.json` in its state directory to remember that it took the PC
  off offer itself. Before serving a renter it also notes the current boot id and their
  session. If the agent starts again in a boot where a renter was already served, the
  reboot never happened, so it serves and offers nobody and reboots again. A session the
  server still names after the agent served it (a crash, or ending it failed) is never
  taken off offer as the owner's: it ends as the host's.
- **Goes back to Windows** when the owner asks at the PC, when the owner stops sharing
  from elsewhere, or when the share-until passes. It puts Windows Boot Manager first in
  the firmware boot order and reboots.
- **On boot**, it first ends any host session a crash left behind. A session still live
  is served at once, with a new key.
- **Opens the persistent state only for an untouched system** (report §5.3, the U/V split),
  before anything else on boot. The state is a LUKS2 partition whose key is U XOR V: U is
  sealed to this PC's TPM under Swiff's signed PCR 11 policy (a `systemd-creds` credential
  made with `--with-key=tpm2-with-public-key --tpm2-public-key=/run/systemd/tpm2-pcr-public-key.pem`
  and opened with `--tpm2-signature=/run/systemd/tpm2-pcr-signature.json`, so only a signed
  Swiff OS boot of this PC unseals it; the id of the V it pairs with is kept beside it), and
  V is the server's share, released
  (`POST /api/machines/:id/state-key`, see `docs/system-design/session-keys.md`) only to a
  fresh, unused host certificate from this machine's latest attested boot. Every try
  attests afresh. `404 no-state-key` or `409 continuity-gap` (something else booted since)
  takes a new V on the same certificate (`PUT`) and formats the partition anew with a fresh
  U; a V whose id is not the sealed U's (a format cut short, or a seal that failed, which
  closes the partition again) is renewed the same way on a new certificate. When U does not
  unseal, or U XOR V does not open the partition, the same unseal is not tried again: the
  state is renewed the same way on a new certificate. `401 stale-host-cert` attests again
  at once, once. Refused otherwise (`revoked`, `firmware-cooldown`, ...) or with the server
  unreachable, the agent keeps the PC off the market (no socket, no heartbeat, no offer),
  shows the refusal on the status page (`locked`; `unseal-failed` when U did not open the
  state and the renewal failed other than by a refusal), and tries again after 5 s, 15 s,
  30 s, 1 min, 2 min, then every 5 min, or after the server's `retry-after` when longer.
  The attestation client gets 60 s, and each state-key call 30 s. The owner can take the PC
  back to Windows at the PC throughout, even while a try is under way. The combined key reaches `cryptsetup` only on its stdin and is never
  written anywhere; it and both shares are zeroed once the state is open. The config's
  `state` names the partition (`device`, `mountpoint`), U's credential (`localShare`) and
  `attestCommand`, the attestation client that prints a fresh host certificate as JSON,
  until attesting is part of the agent. A machine whose config has no `state` has no such
  partition, and skips this.

Two open decisions are each one setting in `hostd/src/config.ts`, with provisional
defaults:

- **D8 `OWNER_TAKEOVER`** (`"when-idle"`). The owner gets the PC back only while it is
  idle: offered, or not offered at all (below the hardware floor, or its key refused).
  While offered, the agent first checks with a heartbeat: if the server shows a session,
  the answer is `session-live` and that renter is served; otherwise it takes the PC off
  offer itself, as a reset, so a claim that lands meanwhile is kept, answered
  `session-live` and served; with none it answers `ok` and goes back to Windows. During a session the answer is
  `session-live`; while the agent is starting or resetting it is `busy`, and the owner
  tries again shortly. A refused request is never kept for later. Set it to `"always"`
  to end a live session as the owner taking the machine back.
- **D3 `HARDWARE_FLOOR`.** The agent does not offer the PC unless it has UEFI, Secure
  Boot on, a TPM 2.0 and an IOMMU. The server's attestation verifier
  (`server/src/tpm-verifier.ts`) judges the TPM's EK certificate and the lower trust tier
  for a discrete TPM.

```bash
npm test -w @swiff/hostd                  # unit tests, and some against the real server (build it first)
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts      # the agent
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts status
SWIFF_HOSTD_CONFIG=hostd.json node swiff-os/hostd/src/main.ts return-to-windows
```

The agent runs as TypeScript source on Node 22.18 or later, using Node's own type
stripping, so there is no build step. The config format is in
`hostd/hostd.example.json`. `serverUrl` must be `wss://`, since the machine key rides on
it; plain `ws://` is accepted only for a server on this machine. `status` and
`return-to-windows` talk to the running agent over its control socket, which only root
can use.

**Not yet here.** These come in later stages:

- The end-of-session steps that come before the reboot: wait for Steam Cloud, upload
  saves that are not in Steam Cloud, log Steam out.
- The persistent state partition in the image (the agent already formats it and enrols
  its key, sealing U and taking V, the first time the server has no V for the machine).
- Attesting, and hosting on the host certificate it earns in place of the machine key
  (the server side is merged; `HOSTING_ATTESTATION=optional` serves the machine key at
  the `unattested` tier meanwhile), then re-attesting before each session.
- Holding the PC back until its games are verified.
