# Swiff OS

Swiff OS (shown to owners and in the boot menu as Lanterel OS) is the rental mode for host PCs: a locked Linux system that a host PC boots into while it is
shared. The renter's Steam session runs on an immutable, measured OS that the owner has no admin rights
on. The design is in the rental-mode report (§5–§8, staged plan in §11). This directory is built up
stage by stage.

| Directory   | What it is                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| `image/`    | The mkosi build of the Swiff OS image (stage 1)                                      |
| `vm/`       | The VM test: builds the image and boots it under Secure Boot with a TPM              |
| `streamer/` | `swiff-streamer`: gamescope's picture and sound to the renter, their input back in   |
| `hostd/`    | `swiff-hostd`: connects the PC to the platform and runs one renter session at a time |
|             | and `swiff-attest`, its attestation client: this boot's TPM quote to the server      |
| `steam/`    | `swiff-steam-login`: Steam's QR sign-in on Swiff's page, then the game               |

## Server: hosting requires attestation

The server side lives in `server/`, not here: `server/src/attestation.ts`. A machine's rights
are split in two. The machine key, which stays in the owner's host app, keeps the control
rights. A short-lived host certificate, which `swiff-hostd` earns by attestation, gets the
hosting rights: `session-claimed` and session keys.

`HOSTING_ATTESTATION=required` switches an environment to attested-only hosting. The default,
`optional`, keeps today's desktop hosts working at an explicit `unattested` tier. The verifier
is an interface: `tpm` (`server/src/tpm-verifier.ts`) for production, and the `insecure-dev`
stub for VMs and tests. The contract is in
[`docs/system-design/session-keys.md`](../docs/system-design/session-keys.md), "Control and
hosting credentials".

## Host app: preflight, install, uninstall and switch

The owner's side lives in `desktop/`: `desktop/rental.cjs` reads, without administrator
rights, what Swiff OS needs from the PC (UEFI, Secure Boot, TPM 2.0, IOMMU, disk space,
BitLocker, graphics card, Fast Startup), and the Rental mode screen
(`desktop/src/screens/Rental.tsx`) shows it with the BIOS steps the owner must take by hand.
The Secure Boot db and the TPM's endorsement certificate need administrator rights, so they
show as not checked yet.

**The installer.** `rental.cjs` plans each change as steps of operations, and the app runs
them for real: one UAC prompt starts the app again as administrator, as a worker
(`desktop/rental-worker.cjs`) that takes the operations one at a time over a named pipe
(`desktop/rental-exec.cjs`). Each end proves it holds the one-time token the app started the
worker with, without sending it, and every later message is sealed with a key from that
token and both ends' nonces, so a process that opens or relays the pipe cannot add an
operation. The owner's one OK starts the run, and every step runs by itself up to the
restart, which waits for the owner's Restart now.

**The BitLocker recovery key first.** When BitLocker protects C: or the games drive, nothing
that changes what the PC starts (the install, the key's restarts, Go live, Remove Swiff OS) is
offered until the owner has saved that drive's recovery key where they can reach it from
another device: the screen says where it can be (their Microsoft account, a file, paper), opens
Windows' own BitLocker page (Back up your recovery key), and sends a Windows Home owner to
aka.ms/myrecoverykey, where Device encryption put it. The owner says they saved it, and main
refuses a boot change's run until they have. Swiff never reads, sends or keeps the key:
`desktop/recovery-key.cjs` keeps only that the owner said so, for which drives, and when, and a
drive BitLocker protects later asks again. The install:

1. checks, as administrator, that Secure Boot is on, the TPM is ready, the db trusts the
   Microsoft UEFI CA 2011 that signs Ubuntu's shim (the 2023 CA does not sign it yet), C: can
   shrink that far, and every file of the image set matches its SHA-256
2. suspends BitLocker on C: for 3 restarts (`manage-bde -protectors -disable -RebootCount`)
3. turns off Fast Startup, shrinks C: by 24 GB (`Resize-Partition`), or uses free space
4. adds Swiff OS's six partitions with the image's ids, names and attributes (`gpt.cjs`
   on `\\.\GLOBALROOT\Device\HarddiskN\Partition0`, then `Update-Disk`)
5. writes the ESP and slot A, hashing as it writes and reading back, then, when the host app
   has an error-reports project, `LANTEREL.ENV` onto the ESP ("Error reports" below)
6. adds a `Boot####` entry for `\EFI\swiff\shimx64.efi` on Swiff OS's ESP, last in BootOrder
   (`desktop/efi.cjs`, through `SetFirmwareEnvironmentVariableEx`: bcdedit cannot name a
   second ESP without a drive letter)
7. names the games drive `SWIFFGAMES`, queues Swiff's key as a MOK (MokNew, MokAuth) with a
   one-time code and `MokTimeout` -1, and sets BootNext; on Restart now the PC restarts into
   MokManager's blue screen, whose menu then waits for the owner instead of counting down

The worker trusts nothing it is sent: it adds only the image's own partitions, writes only
into partitions it added, and removes only what it added. What it changed goes into
`%ProgramData%\Swiff\rental-install.json` (writable by administrators only), which the
uninstall works from: boot entry (kept by what it starts, its partition's GPT id and shim's
path, since firmware renumbers `Boot####`), partitions, C:'s space back, the drive names, Fast
Startup and BitLocker.

**Remove Swiff OS** starts with one click on the Rental screen (`removePlan` in `desktop/rental.cjs`),
in two parts across a restart, with one confirmation on MokManager's blue screen. With Swiff's key enrolled it starts with the key: MokManager,
which removes it once the owner confirms with a new code, lives on Swiff OS's own boot
partition, so the key comes off first (BitLocker on C: suspended for that restart). Back in
Windows, the app goes on by itself (Windows may ask once more for permission) with the uninstall: the boot entry, every request for shim (MokNew,
MokDel, MokTimeout), the six partitions, the drive Swiff OS came from grown back to its size,
the names, Fast Startup and BitLocker as they were; then a check as administrator that no
`Boot####` starts shim, no request is queued and none of the partitions is on the disk; then a
restart. An install that stopped part way (no key went in) goes straight to that second part.
`desktop/rental-removal.cjs` records each part in the app's own data, and the start after the
removal is checked against it, without administrator rights: Windows started without Swiff OS's
loader (this start's measured-boot log), the partitions are gone, the drive has its space back,
BitLocker is on again where it was, and the install record is gone. The screen shows each,
marked where one is not as it was. Should the owner miss the blue screen, the removal goes
on without the key (shim, the only thing that would trust it, is gone with the partitions), or
they ask for the key's removal again. Once installed, going live reads the TPM's EK
certificate as administrator and sets only BootNext for now, both only once the server has that EK
registered: the read stops before BootNext when the TPM has another than the one registered, and
the app registers it and goes live again, stopping without one (see Attestation in
`docs/system-design/session-keys.md`); the restart after that is Windows again, and Swiff OS first in
BootOrder waits until Swiff OS can hand the PC back. Without `MokTimeout`, MokManager waits only 10 seconds, then drops
the request; shim then fails to verify the next stage and falls through into Windows in the
same power-on, which changes PCR 7 (Windows Hello then asks for a new PIN, and BitLocker for its
recovery key), as Continue boot does at MokManager's menu. So every request and every Swiff OS
start sets `MokTimeout` -1, the app tells the owner never to choose Continue boot, and the key's
restarts suspend BitLocker. Back in Windows the app reads Windows' measured-boot log (TCG,
readable without administrator rights): shim starting Swiff's `grubx64.efi` means the key
works; shim, MokManager and Windows in one power-on means it did not go in, and the app offers
Confirm the key with a new code. The same log holds the Secure Boot db the firmware measured,
so whether it trusts the CA that signs shim is read without a trip to the BIOS. After a clean
restart, whether the key is enrolled cannot be read from Windows (shim publishes MokListRT only
to what it starts), so the app asks the owner.

**The image set** (`swiff-os/image-set.sh`, read by `desktop/image-set.cjs`) is what the
installer writes: the build's ESP files on a FAT32 with 512-byte sectors (Windows' chkdsk
wrecks the build's 4,096-byte-sector FAT on the 512-byte-sector disks nearly every PC has, so
the installer offers only those disks), with `\EFI\swiff\` added (Ubuntu's Microsoft-signed shim
from the image's own archive snapshot, MokManager, and the build's signed systemd-boot as
`grubx64.efi`, the name shim starts), slot A and its verity hashes, Swiff's certificate, and
`swiffos.json` with the layout and each file's SHA-256, signed (`swiffos.json.sig`, Ed25519),
and `SHA256SUMS`, every file's SHA-256 as `sha256sum` prints it.
The app looks for it in `$SWIFF_OS_IMAGE_DIR`, else `swiff-os` in its user data folder (where
it downloads the set when none is there, below under **Release keys**), and
reads no manifest that a key in `desktop/image-trust.json` did not sign, nor a set whose
certificate is not the one that key's sets carry; a set that is there but not signed by Swiff
shows as that on the rental screen, with Check again. The installer's administrator side keeps the
set in `%ProgramData%\Swiff\swiff-os`, which only administrators can write: its check reads the
signed manifest and the certificate there and hashes each image where it is, before anything on
the PC changes, and each image is copied there, checked again as it is copied, only at its write (after C: has given Swiff OS its room), then removed once written. The
release signs with Lanterel's release image signing key in `$SWIFF_OS_SIGNING_KEY` (below,
**Release keys**): it never enters the repository, and its public half and the
SHA-256 of the Secure Boot certificate release sets carry are what `desktop/image-trust.json`
lists. A release build (`npm run pack`, or an unpackaged run) reads no set signed by another key,
nor one built with another Secure Boot certificate, and refuses every set while that list is
empty. Without `$SWIFF_OS_SIGNING_KEY`, `image-set.sh` signs with the developer's own
key (`~/.config/swiff/image-dev-key.pem`, made on first use) and writes
`desktop/image-trust.dev.json`. Either key file is kept encrypted (PKCS#8, AES-256), never as a
plain PEM, and unlocked with `$SWIFF_OS_KEY_PASSPHRASE` (the release key's passphrase file, or
asked for on a terminal); a key file that is not encrypted is refused.

**Release keys.** Lanterel signs real Swiff OS builds with two keys of its own, made by
`swiff-os/release-key.sh <key-dir> <backup-file>` on the machine that signs releases, the GEEKOM,
and kept there in `~/.lanterel-keys/release/` (0700, owned by its user, every secret file 0600):

| File                           | What it is                                                              |
| ------------------------------ | ----------------------------------------------------------------------- |
| `image-signing-key.pem`        | the Ed25519 key that signs each set's `swiffos.json` (encrypted PKCS#8) |
| `image-signing-key.passphrase` | what unlocks it                                                         |
| `secure-boot.key`, `.crt`      | the Secure Boot key pair: the certificate is the MOK each host enrols   |
| `backup.passphrase`            | unlocks the encrypted backup, nothing else: it belongs offline          |
| `public.txt`                   | the public halves and their fingerprints, as the script printed them    |

The Secure Boot key pair (RSA-2048, self-signed, `CN=Lanterel OS Secure Boot`, as `mkosi genkey`
makes one) signs systemd-boot, the UKI and its expected PCR values. Its key is not encrypted, so
mkosi signs without asking; the folder's permissions are what keep it.

The backup, `~/fm-swiff/data/secrets/lanterel-release-keys.tar.gpg` on the GEEKOM, holds both
keys and the image key's passphrase, encrypted with gpg (symmetric, AES-256) under
`backup.passphrase`. None of it is ever copied into a repository, a log, CI or a chat: CI holds no
release key, and releases are signed on the GEEKOM. `node desktop/image-set.cjs add-trust
~/.lanterel-keys/release/public.txt` adds the public halves to `desktop/image-trust.json`
(the public key and the certificate's SHA-256), working each out from the PEM itself
and refusing input with a private key in it. It lists the pair made on 2026-10-07: image signing
key fingerprint `9a046b4b82a8963ccffb8416673ed38c7e0783c30ada578383779359a553ab24`, Secure Boot
certificate SHA-256 `2480ad54b30788ed735522289b7d9765d9f0b224dee5d49dba31a3017768bccd`.
The image signing key's fingerprint (SHA-256 of its SPKI DER) is for people only: keep the one
`release-key.sh` printed when it made the key, and before trusting or rotating compare it with the
one `node desktop/image-set.cjs public "$k/image-signing-key.pem" "$k/secure-boot.crt"` prints now
(with `k` and `SWIFF_OS_KEY_PASSPHRASE` set as for a release, below).

A release is built and signed on the GEEKOM with those files in place of the VM test key pair:

```sh
k=~/.lanterel-keys/release
swiff-os/image/stage.sh ~/.cache/swiff-os/release
sudo mkosi -C swiff-os/image --secure-boot-key="$k/secure-boot.key" --secure-boot-certificate="$k/secure-boot.crt" \
  --output-dir ~/.cache/swiff-os/release --cache-dir ~/.cache/swiff-os/cache -f build
SWIFF_OS_SIGNING_KEY=$k/image-signing-key.pem SWIFF_OS_KEY_PASSPHRASE=$(cat "$k/image-signing-key.passphrase") \
  swiff-os/image-set.sh ~/.cache/swiff-os/release swiffos <set-dir>
```

`image-set.sh` checks a release set as a release build would once it is signed, so a set built
with the VM test certificate, or signed before `image-trust.json` lists its key, fails there and
is never published.

Hosts download the set themselves: the Lanterel Host app fetches it from the GitHub release
`swiffos-<version>` (`desktop/image-download.json`), so publish the set's `download/` parts,
`swiffos.json` and `swiffos.json.sig` there, all at the release's top level:

```sh
gh release create swiffos-0.1.0 <set-dir>/download/* <set-dir>/swiffos.json <set-dir>/swiffos.json.sig
```

The app reads nothing from the release unless a key in `image-trust.json` signed its
`swiffos.json`, and keeps no part or file whose size and SHA-256 differ from what it lists. Each
file is gzip-compressed and cut into parts under 1.9 GiB (a release takes at most 2 GiB a file): the
8 GiB root, mostly empty, packs to about 1.3 GB, the whole set to about 1.4 GB.

To rotate the keys (on suspicion of a leak, or to move them into an HSM, which is a rotation like
any other): make the new pair into a new folder (`release-key.sh ~/.lanterel-keys/release-<date>
<backup-file>`), `add-trust` its `public.txt` beside the old entry, and ship an app release that
trusts both. A set carries one signature and one certificate, so during the transition sets stay
signed with the old pair while app releases that trust the new one reach hosts, and hosts enrol
the new certificate as a MOK before they boot a build signed with it. Then sign with the new pair,
take the old entry out of `image-trust.json` in the next app release, and destroy the old key and
its backup.

**Test builds.** `npm run pack:test` in `desktop/` packages the portable app as `npm run pack`
does, with `swiffBuild: "test"` baked into its `package.json` (`desktop/build-kind.cjs`). Only
that build, the one for the GEEKOM and the VM, trusts `image-trust.dev.json` (run `image-set.sh`
first, so it is there to package), and its rail says "Test build". Nothing at run time, neither
the environment nor whether the app is packaged, makes a build a test build. The VM tests'
console installer (`desktop/rental-cli.cjs`) trusts the developer's key as well.

**Tests.** `desktop/vm/windows-install-test.sh` runs the installer, unchanged, on Microsoft's
Windows 11 Enterprise evaluation in QEMU/KVM, with OVMF and Microsoft's Secure Boot keys, a
software TPM and BitLocker on, scenario by scenario: Secure Boot already fine, the
administrator prompt declined, not enough space, an install stopped part way and undone, a
fresh install whose key screen is left waiting and then Continue boot, a power-off at the key
screen, the key confirmed (PCR 7 as a clean start's each time, as `vm/pcr7.py` replays it),
Swiff OS started once through shim with its ESP still sound, Remove Swiff OS after the partial
install and after the full one (its key at MokManager, the app going on by itself, the restart, and the
app's check of the start after it: Windows back, its space and BitLocker as before, no boot
entry or request for shim left), a reinstall, a second app instance, Secure Boot off, and the packaged test build
driven through its own screens. `desktop/rental-cli.cjs`
drives the same installer from a console, one step at a
time. `desktop/vm/rental-install-test.sh` downloads the image set as a host does (packed in
several parts, served from a local HTTP server), carries the plans out with it on a disk image with
`apply-plan.cjs` standing in for Windows, and boots the shim chain under OVMF with
Microsoft's keys; `desktop/vm/mok-enroll-test.sh` confirms the app's MOK request at MokManager,
after a miss and then with the code.

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

| Partition      | Size    | Contents                                                                                       |
| -------------- | ------- | ---------------------------------------------------------------------------------------------- |
| ESP            | 1 GiB   | systemd-boot and the signed UKI                                                                |
| root, slot A   | 8 GiB   | read-only erofs root under dm-verity, labelled `swiffos_<version>`                             |
| root-verity, A | 128 MiB | its dm-verity hash tree                                                                        |
| root, slot B   | 8 GiB   | empty (`_empty`), for the next version                                                         |
| root-verity, B | 128 MiB | empty (`_empty`)                                                                               |
| scratch        | 6.4 GiB | per-boot encrypted scratch: `/home`, and the games view's writes when the library is read-only |

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
- **The session is the whole UI.** `swiff-session.service` runs gamescope on tty1 as `renter`, with
  `NoNewPrivileges`, and gamescope runs the Steam sign-in agent (`steam/session`, below): Steam at
  its sign-in window, then the game the renter booked, never Steam's own UI. It starts only after
  `nftables.service` has loaded the firewall and does not start at all if loading fails. There is no
  display manager, desktop, getty, serial console login or sshd.
- **The rental-mode agents are in the image.** `swiff-hostd` (root, `swiff-hostd.service`), the
  streamer it starts for each renter as `swiff-stream`, and the Steam sign-in agent run on Ubuntu's
  Node 22 from the same pinned snapshot. That Node is built without TypeScript type stripping, so
  each is one bundled file. The streamer's GStreamer encodes on the GPU through VA-API (AMD
  through Mesa, Intel through its media driver) or with x264; NVIDIA stays out of the image with
  NVIDIA's driver. The renter's PipeWire carries gamescope's picture and the game's sound.
  `image/stage.sh <output-dir>` builds and stages them into the output directory, which the image
  takes as an extra tree; run it before every build. `swiff-hostd` starts only on a machine that
  has its config, `/var/lib/swiff/hostd.json` (see swiff-hostd's "Not yet here").
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
can delete the table, which costs a new bootstrap, but cannot forge it. A table over 256 MiB, or one
nested to exhaust the JSON parser, is refused as tampered before its HMAC is checked. Rental mode
never writes on the volume through a symlink: if `SwiffOS` is not a real folder, the library is used
read-only for that boot.

The key is created only when there is none. If it no longer unseals, for example after a Secure Boot
update changed PCR 7, rental mode tries three times, then keeps the credential and blocks every game.
The report's `table` field tells the host app that the owner must bootstrap the games again. That
bootstrap is the only thing that seals a new key: the new table then holds just the games it validated.
If the TPM cannot seal a key, rental mode runs as without one: every game stays unverified, any old
credential is kept, and nothing is promoted, not even the owner's bootstrap.

A table that cannot be read (an I/O error, or not a regular file) or that has a newer version than
this OS, as after a rollback to the other slot, is kept as it is: every game shows as not
bootstrapped, nothing is promoted, not even the owner's bootstrap, and the next boot hashes in full.
A table that fails its integrity check, including corrupt JSON, is not kept: the next boot replaces
it with an empty table, so every game shows as not bootstrapped until the owner bootstraps it again.
If it turns bad while rental mode runs, a renter's update is refused, and the owner's bootstrap
replaces it with a table of just the games it validated.

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
3. **`swiff-verify close-seal`** runs before anything the user drives starts. It waits for a seal
   that is still running, and afterwards nothing can be sealed in this boot. `swiff-session.service`
   runs it at start, before the Steam sign-in agent starts Steam. The agent will call it instead
   just before it launches the game.
4. **Promotion** runs at shutdown (`ExecStop`), after the session has stopped, so it fits the reboot
   between renters (D5). For each sealed game, the files that the session layer still holds
   **byte-identical** to what was sealed are copied onto the library. The table and Steam's app
   manifest are then updated, the manifest without the renter's SteamID. A sealed file the session
   layer does not hold is re-hashed on the library first and must still match. One changed or
   unreadable file keeps the whole update off the library. The game is marked `promoting` while its files are renamed into
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
swiff-os/vm/vm-tests.sh             # the VM tests this branch's changes touch (--list, --only selftest,...)
swiff-os/vm/run-test.sh             # build the test image if its inputs changed, boot it twelve times, check everything
swiff-os/vm/run-test.sh --no-build  # boot the last build again (--rebuild: build it anyway)
swiff-os/vm/session-test.sh         # a renter plays on rental mode end to end (below)
# the shipped image only, as swiffos.raw in the given output directory
swiff-os/image/stage.sh ~/.cache/swiff-os/output
sudo mkosi -C swiff-os/image --output-dir ~/.cache/swiff-os/output --cache-dir ~/.cache/swiff-os/cache build
```

Build output, caches and the VM's disk overlay and logs go to `$SWIFF_OS_BUILD_DIR` (default `~/.cache/swiff-os`), outside the
source tree. The build runs as root, and the root-only directories it leaves would break tools that
walk the repository, such as `prettier --check .`. The first build downloads about 2 GB and takes
a while; later builds reuse the caches. `vm/build-image.sh` builds a test profile only when its
inputs changed (`image/`, the profile's `vm/` tree, what `stage.sh` stages, mkosi's version) and
keeps the newest three builds of each profile in `$SWIFF_OS_BUILD_DIR/images`, keyed by those
inputs; each run boots a copy-on-write overlay of one, so the build itself is never written. If
`image/mkosi.key` and `image/mkosi.crt` do not exist, it copies this PC's throwaway Secure Boot key
pair there, made once in `$SWIFF_OS_BUILD_DIR/test-key`, so that every worktree signs alike and
reuses the same builds. The key pair is git-ignored and for VMs only.

Every VM test starts QEMU through `vm/vm-run.py`. It waits until this PC's test VMs, this one
included, hold at most `$SWIFF_VM_RAM_BUDGET` MiB (8192) and the PC has the VM's memory and 1.5 GB
more available, and runs QEMU in a systemd user scope with its memory capped and never swapped
(a guest the host swaps out stalls, and swapping is what freezes the PC). Its watchdog stops only
that VM, and says why, when it outlasts its timeout, when its console stays silent too long, or
when the PC runs out of memory (the newest VM first).
systemd-repart makes the root's erofs in a tmpfs inside mkosi's sandbox, half the build
machine's RAM, and needs about twice the root's size there: on a 10 GB machine such as the
GEEKOM, a root of up to about 2.4 GB. The root is about 2.3 GB.

`run-test.sh` builds the `selftest` profile. That is the shipped image plus a serial console and
`swiff-selftest.service` (`vm/selftest/`). In the test build the session starts only after the
self-test, so sealing stays open, as it would until a game is launched. The test then boots the
image twelve times in QEMU, with 2 GiB of RAM and 4 vCPUs, under OVMF with Secure Boot and swtpm:

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
8. **Boot 7.** The self-test rewrites the table with a newer version, as the other slot's OS would,
   and the owner bootstraps one game. Nothing is promoted at shutdown.
9. **Boot 8.** The newer table was kept as it was. The self-test replaces it with a directory, and
   the owner bootstraps one game. Nothing is promoted at shutdown.
10. **Boot 9.** The unreadable table was kept. The self-test replaces it with corrupt JSON. A
    renter's seal is refused, and the owner's bootstrap replaces the table at shutdown.
11. **Boot 10.** The host damages the table key's credential again, and in this boot the TPM cannot
    seal (the self-test's `systemd-creds` refuses to encrypt for the games service). The owner
    bootstraps one game. At shutdown nothing is promoted, the old credential is kept byte for byte,
    and no temporary credential or new table is left.
12. **Boot 11.** The host removes the table key and the table, and the TPM still cannot seal. The
    games service starts, every game stays unverified, and no credential is left on the library.
13. **Boot 12.** The same disk with an ext4 library.

Before it builds, the script runs `vm/test_verify.py`, host-side tests of `swiff-verify`'s decisions on
plain folders, with the TPM and `systemd-creds` stood in for. They cover a TPM restart after a
hibernated OS, the session layer's size, an update that does not fit on the library or whose copy is
cut short, a block that must survive the next quick check, a table key that does not unseal or a
TPM that cannot seal one, a newer table that a bootstrap must not replace, symlinks another OS left
on the library, a close-seal that must wait for a running seal, KeyValues nested too deeply, corrupt
or mistyped depot manifests, and a table that is too large or nested too deeply. Run them alone with
`python3 swiff-os/vm/test_verify.py`.

The games library comes from `vm/games-fixture.py`. It writes a 1 GiB NTFS library through
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
- The session is gamescope with the Steam sign-in agent as `renter`, and no login of any kind is
  offered.
- The rental-mode agents: Node 22 with `fetch` and `WebSocket`, the three bundles root's and
  loadable, `swiff-hostd.service` enabled (it does not start without a config), the streamer's
  user (961, no shell, no other group), `/dev/uinput` for that user's group only, the agent's
  socket directory, the renter's PipeWire and the streamer's grant enabled, and every GStreamer
  element the streamer's pipelines name, VA-API's plugin, and x264 encoding frames.
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
    seals a new one. If the TPM cannot seal, the old key is kept and nothing is promoted, and
    without a key every game stays unverified while the games service still runs.
  - A newer or unreadable table is kept through the owner's bootstrap, and a corrupt one is
    refused for a renter's update and replaced by the owner's bootstrap.
- The disk image fits the 24 GiB budget.

The VM has no GPU, so gamescope cannot start there and the session unit keeps restarting. The test
checks the session's wiring, not a running game; the session test (below) plays one.

### The session test

`vm/session-test.sh` plays a renter's session on the image end to end. It builds the
`sessiontest` profile, the shipped image plus `vm/sessiontest/`, and runs `vm/session-harness.mjs`
in a network namespace of its own, where the real server (with its production `tpm` attestation
verifier) and a TURN relay (coturn) have addresses that look public to the VM (TEST-NET-2), so
the image's firewall treats them as the internet. The VM boots under OVMF with Secure Boot and
swtpm, 2 GiB and 4 vCPUs, and the harness reports each step PASS or FAIL. `swtpm_setup`
manufactures the TPM with an EK certificate from a throwaway local CA, the server's only trusted
TPM vendor. The server's boot policy is this build, signed with a throwaway key: PCR 11 as
systemd-measure predicts it for the built UKI, PCRs 12 and 13 empty, and the boot applications
and Secure Boot authorities the VM's first boot measured (its event log, read off the serial
console before the server starts).

1. The owner offers the PC with the machine key and registers its TPM's EK certificate
   (`PUT /api/machines/:id/ek`), as their app does before the PC restarts into rental mode. A
   fixture disk gives `swiff-hostd` its config and key, as the owner's app will.
2. `swiff-hostd` attests with `swiff-attest`, formats its persistent state (a disk of its own
   here) with U XOR V, V released only to that attested boot, and offers the PC on its
   machine-key socket in rental mode.
3. A renter on the hosted site (headless Chromium, signed in) sees the PC on the wall and holds
   Launch; Ignition waits on the PC. `swiff-hostd` hears the claim, starts the host session and
   the streamer, as `swiff-stream` with no capabilities, no other group and only its three
   settings in its environment; the renter can read neither.
4. The streamer asks the Steam agent to play; Ignition draws exactly the code the PC's screen
   shows, then Steam's fresh one, and bills nothing meanwhile. Steam signs in, the game comes on
   screen, and the renter plays it in Swiff, billed from the first frame after sign-in. Both
   seats hold a relay allocation on credentials the server minted for each, and the test records
   the candidate types of the pair ICE picked, never their addresses.
5. The renter reloads the page mid-session and reconnects to the same session, then ends it.
6. The streamer stops; `swiff-hostd` takes the PC off offer and restarts it clean. In the next
   boot it attests again, opens the same state with U unsealed from the TPM, and offers the PC
   again.
7. The PC is powered off and booted with a kernel command line from outside its signed UKI (an
   SMBIOS string systemd-stub takes and measures into PCR 12). The server refuses its
   attestation (`unknown-boot-extras`), so the PC gets no state key and is never offered.

Two things stand in for what a VM cannot have. gamescope needs a GPU, so a test picture under
gamescope's PipeWire node name and a tone stand in for it. The tone plays through `pw-cat`, not
GStreamer's `pipewiresink`: under PipeWire 1.6 a playing `pipewiresink` audio stream stalls every
capture stream in the session (games play through PipeWire's Pulse and ALSA layers, which do
not). Steam needs an account and a phone, so
`sessiontest/bin` stands in for Steam and for the X tools the agent reads it through: a
`steam` that signs in 20 s after the agent first read its code, and an `xwd` that hands out
X window dumps of two sign-in codes, which the image's own `zbarimg` decodes. The agent, the
streamer, `swiff-hostd`, its attestation client and everything else are the shipped image's
(`sessiontest-attest` only runs `swiff-attest` and counts the certificates it earns). The
persistent state and key disks are not in the image yet.
`swiff-hostd` takes plain `ws://` only from a server on its own machine, so a forwarder on the
VM's loopback carries its signaling to the test's server; the streamer's media does not.

It needs coturn's `turnserver` (`TURNSERVER=path`), Playwright's Chromium
(`PLAYWRIGHT_BROWSERS_PATH`), user and network namespaces (`unshare`) and a `/dev/kvm` this user
can open; it waits for room among this PC's test VMs (`vm/vm-run.py`). `--no-build` runs it on
the last build. The run's serial console, server log and
`results.json` are in `$SWIFF_OS_BUILD_DIR/session-vm`. In the last run all 43 steps passed:
Steam's first code was on the renter's page within a second of the claim, and the PC was offered
again 25 s after the session ended.

`SWIFF_SESSION_RELAY_ONLY=1` puts the renter's browser in a home network of its own, at a private
address the image's firewall refuses, so only the relay can carry the stream. That run does not
pass yet. Both seats get a relay allocation, but the streamer's werift peer loses consent on the
first pair it nominates (its host candidate to the renter's relayed one), and on the connection
the page opens after sign-in it fails every check within 1.6 s without using its own relayed
candidate. Whether a PC behind a real NAT, with a relay elsewhere, does the same is the next thing
to find out: renters only TURN can reach depend on it.

## Follow-ups

- **Shim and MOK in the image.** Real PCs boot through Ubuntu's Microsoft-signed shim, with Swiff's
  key enrolled once as a MOK. The image set adds the shim to the ESP (above); the image's own build
  does not, so its VM test still enrols the test key directly. Swiff's own Microsoft-signed shim is
  deferred.
- **Steam client persistence.** The Steam client's runtime is downloaded into the ephemeral `/home` on
  first start of each boot. It moves to the sealed state partition with attestation (stage 3).
- **Starting the game directly.** The image's session is the Steam sign-in agent (`steam/`,
  below), which starts the game once Steam signs in. What is still to do is in "Not yet here"
  there.
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
- **Games: offering games one by one.** The view is mounted once every game is checked. Until then
  the PC is not offered, so no renter waits. Offering each game as it passes a long re-hash needs the
  rental agent to remount the view between sessions.
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
  `SWIFF_SERVER_URL`, `SWIFF_HOST_ID` and `SWIFF_APPID`, the game booked. `SWIFF_SERVER_URL`
  must be `wss://` unless it points at this machine (loopback), so the session key never
  crosses the network in the clear; only a test may override that (`--insecure-signaling`,
  as the VM test does). It registers with the session key, never sees the machine key, and exits whenever the server puts it out (session
  ended, or the key refused after a reconnect); swiff-hostd decides what follows.
- **Steam sign-in** (`src/steamLogin.ts`, with `--steam-socket <path>`). The streamer
  carries the renter's signaling, so it drives the Steam agent's socket (`steam/` below):
  as the renter joins it asks for `play <SWIFF_APPID>` and relays Steam's codes,
  `signed-in` and `failed` to them as `steam-login`; a renter's `retry` after a failure
  starts a fresh Play on the same claim. `--steam-socket` needs `SWIFF_APPID`; the
  streamer refuses to start without it. The server's `launch-game` is answered with
  `game-started` once the agent says the game is on screen, so the renter's page never
  shows Steam or a desktop. A code is never logged. Sign-in time is not billed: the
  claim of a rental-mode PC says `rentalMode` (swiff-hostd registers with
  `rental: true`, below), and then the renter's page starts the session only once Steam
  says `signed-in`.
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

**In the image.** `image/stage.sh` installs `dist/swiff-streamer.mjs` and `helpers/` side
by side (`/usr/lib/swiff/streamer/dist/` and `/usr/lib/swiff/streamer/helpers/`), and
`system/` as sysusers, tmpfiles, udev rule, `/usr/libexec/swiff/swiff-pipewire-grant` and
the renter's user unit, enabled for every user. The image has what it needs: Node 22,
Python 3 with GObject introspection, GStreamer 1.28 (base, good, bad, ugly, PipeWire, the
VA-API plugin with Mesa's and Intel's drivers) and `acl`. swiff-hostd's `streamer` setting
is then `hostd/hostd.example.json`'s: `{"command": "/usr/bin/node", "args":
["/usr/lib/swiff/streamer/dist/swiff-streamer.mjs", "--pipewire-remote",
"/run/user/1000/pipewire-0", "--steam-socket", "/run/swiff/steam/login.sock"], "uid":
961, "gid": 961}`. `--help` lists the other options: picture size, frame rate, bitrate,
encoder, a test source.

**The VM test.** `vm/run-test.sh` builds a small Ubuntu 24.04 test image with mkosi
(not Swiff OS; only what the streamer needs), boots it in QEMU/KVM with 2 GiB and 4
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
build, pinned by version and checksum and downloaded once into the build directory. It builds the image again only when what goes into it changed (`--rebuild` builds it anyway), waits for room among this PC's test VMs (`swiff-os/vm/vm-run.py`), never touches the host's
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
([`host.md`](../docs/system-design/host.md) §5, `server/src/protocol.ts`). Its `register`
adds `rental: true`: the server stores the PC as rental mode, and its claims say
`rentalMode`, so the renter's page bills nothing before Steam signs in. The desktop app
does not send it. Until the agent attests, this declaration is what makes the PC rental
mode; a socket on an attested host certificate is rental mode either way.

- **Holds the machine key; the streamer never sees it.** The key is in a file root owns
  and only root can read (mode 600); the agent refuses any other. For each renter
  session the agent gets a 5-minute session key (`POST /api/machines/:id/session`) and
  hands it to the streamer on stdin. The streamer runs as its own unprivileged user. Its
  environment carries only `SWIFF_SERVER_URL`, `SWIFF_HOST_ID` and `SWIFF_APPID`, and
  the error-tracking variables when the agent has them ("Error reports" below).
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
  `attestCommand`, the attestation client that prints a fresh host certificate as JSON
  (`/usr/libexec/swiff/swiff-attest`, below). A machine whose config has no `state` has no such
  partition, and skips this.
- **Attests with the TPM** (`swiff-attest`, `hostd/src/attest.ts`; the server's verifier is
  `server/src/tpm-verifier.ts`). It talks to `/dev/tpmrm0` with raw TPM 2.0 commands
  (`hostd/src/tpm.ts`, no tpm2-tools), as `server/scripts/tpm-fixtures.mjs` records the
  verifier's fixtures. The EK is the TCG default template's (RSA 2048, persisted at
  `0x81010001` or made afresh, else ECC P-256): the key whose certificate the owner's Windows
  registered. A fresh ECC P-256 AK is made under it. The server's challenge, then
  `attest-activation` wraps a credential to the EK for that AK, which `TPM2_ActivateCredential`
  recovers. `TPM2_Quote` by the AK over SHA-256 of the challenge covers SHA-256 PCRs 0-7 and
  11-13; the PCRs are read right after and quoted again if one moved in between. `attest` gets
  the quote, the PCR values and the firmware's event log
  (`/sys/kernel/security/tpm0/binary_bios_measurements`). It prints the host certificate it
  earns, or a refusal naming the verifier's reason on stderr. Its tests run it on swtpm against
  the real server's `tpm` verifier (`npm test -w @swiff/hostd`, skipped without swtpm).

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

From a checkout the agent runs as TypeScript source on Node 22.18 or later, using Node's own
type stripping. The image's Node (Ubuntu's) is built without it, so the image runs one
bundled file, `dist/swiff-hostd.mjs` (`npm run build -w @swiff/hostd`, which
`image/stage.sh` runs), from `swiff-hostd.service`. The unit starts it once the firewall is
up and the games are checked, and only when its config is there. It runs as root in a
sandbox of its own (private `/tmp`, `/home` hidden, no new privileges, no kernel modules,
logs or control groups); the streamer it starts inherits that and drops to its own user. The
config format is in `hostd/hostd.example.json`, with the image's streamer. `serverUrl` must
be `wss://`, since the machine key rides on it; plain `ws://` is accepted only for a server
on this machine. `status` and `return-to-windows` talk to the running agent over its control
socket, which only root can use.

### Error reports

The agent, the streamer and `swiff-steam-login` report their failures to PostHog's error
tracking (`packages/error-tracking`): what nothing caught, which still ends the program
as Node would have, the streamer's exit 1, and Steam that does not start. A report is an
error's type, message and stack, the program's name, and nothing about who: a random id
for the run, no person profile, no location, and every string scrubbed of Steam IDs,
e-mail and IP addresses, user names in paths, invite links, keys and tokens, and the
machine id and key by name. Each program sends the same failure once per run, and 50
reports at most.

Reports are off unless the program's environment names a project, and off whenever
`DO_NOT_TRACK` is set (to anything but `0`):

| Variable                | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| `LANTEREL_POSTHOG_KEY`  | the project's public key (`phc_...`), never committed      |
| `LANTEREL_POSTHOG_HOST` | its ingestion host, `https://eu.i.posthog.com`; https only |

The root is read-only and `/var` a tmpfs, so they come from the one place Lanterel Host
writes that Lanterel OS can read: its ESP. Installers carry no key: the hosted Lanterel
server serves its own `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` (the web app's project,
built by the same Render service) at runtime at `GET /api/error-tracking`, and a dev build
may override them with its own. When the host app has a project from either and the
PC does not set `DO_NOT_TRACK`, the install writes `LANTEREL.ENV` (`NAME=value` lines) into
the ESP's root directory, after the ESP is written and read back against its SHA-256
(`desktop/esp-file.cjs`); without them it writes none, and a new install writes the ESP
afresh, so no file is left from before. In Lanterel OS `swiff-esp.service` mounts the ESP
systemd-boot started from (`LoaderDevicePartUUID`) read-only and root's alone at
`/run/swiff/esp`, and `swiff-hostd.service` points the agent at the file
(`LANTEREL_ERROR_TRACKING_FILE`). Windows can write the ESP, so the agent treats the file
as untrusted: it takes only those two names from it, never as an `EnvironmentFile`, and
only a `phc_` project key and an `https` host on `posthog.com`; anything else leaves
reports off. Each streamer it starts gets the error-tracking variables the agent has
(`LANTEREL_POSTHOG_KEY`, `LANTEREL_POSTHOG_HOST` and `DO_NOT_TRACK`, each only when set),
beside its own `SWIFF_SERVER_URL`, `SWIFF_HOST_ID` and `SWIFF_APPID`, and none of the agent's
other settings. `swiff-steam-login` runs in the renter's session, not under the agent, and the file
is root's alone, so `swiff-error-tracking.service` checks it the same way at boot
(`swiff-hostd session-env`) and writes the project alone to `/run/swiff/error-tracking/session.env`,
root's alone too; `swiff-session.service` reads that as an `EnvironmentFile`, which systemd opens as
root. Without a project the file is empty and the session reports nothing.

**Not yet here.** These come in later stages:

- The end-of-session steps that come before the reboot: wait for Steam Cloud, upload
  saves that are not in Steam Cloud, log Steam out.
- Its config on a real PC. The image starts the agent only once `/var/lib/swiff/hostd.json`
  and the machine key are there, and `/var` is a tmpfs: how the owner's app hands Swiff OS the
  machine id, key and server is still to decide and build. The session test gives it them on
  a fixture disk.
- The persistent state partition in the image (the agent already formats it and enrols
  its key, sealing U and taking V, the first time the server has no V for the machine). The
  agent's `stateDir` belongs on it: on the tmpfs `/var` the agent would forget, across its
  own restart, that it took the PC off offer itself, and go back to Windows. The session
  test has both on disks of their own.
- Hosting on the host certificate `swiff-attest` earns in place of the machine key (the
  server side is merged; `HOSTING_ATTESTATION=optional` serves the machine key at the
  `unattested` tier meanwhile), then re-attesting before each session.
- Holding the PC back until its games are verified.

## Steam sign-in, straight into the game (`steam/`)

When the renter presses Play, the game starts. If Steam needs them to sign in, Swiff's
own Ignition screen shows Steam's sign-in QR code. They scan it with the Steam app and
approve, and the game starts. They never see Steam's library, any other Steam window
or a desktop. Nobody types a password or a Steam Guard code.

- **The session** (`steam/session`) is gamescope with the agent, `src/main.ts`, as its
  only program, run as the `renter` user. The agent starts Steam with `-silent`, so
  Steam opens only its sign-in window. The agent serves Plays on a local socket
  (`src/serve.ts`, default `/run/swiff/steam/login.sock`).
- **Ready before the renter comes.** Steam sits at its sign-in window from boot.
- **Play** is `play <appid>` on the socket. The streamer sends it as the renter joins
  (`streamer/src/steamLogin.ts`), since it carries the renter's signaling. The agent reads Steam's QR code off the screen with the stock X
  tools and zbar (`src/x11.ts`) and sends the link it encodes as a `qr` event. Steam
  shows a new code every 20 to 25 s, and each new one is sent within one 250 ms poll.
  The streamer relays each code to the renter as `steam-login` (`server/src/protocol.ts`).
  The server relays it from the PC to the renter only, and the renter has it before
  the stream connects. Ignition redraws it, in the dial's place, as Swiff's own QR code
  (`web/src/swiff/SteamSignIn.tsx`). It draws only `https://s.team/q/…` sign-in links.
- **No credentials pass through Swiff.** Steam runs the whole sign-in itself. The agent
  only copies the picture of Steam's code, the way a camera would. Each screen grab
  goes to a private temporary directory and is deleted as soon as it is read. Nothing
  logs a code: not the agent, not the server. Steam's own console output is kept out of
  the journal.
- **Steam does not remember the sign-in.** Before it starts Steam, the agent writes
  Steam's settings (`~/.steam/registry.vdf`) with `RememberPassword` `0` and no
  `AutoLoginUser`: the "Don't save account credentials on this computer" choice of
  report 6.2. Whatever Steam still keeps of the sign-in stays in the renter's home,
  which goes when the PC restarts after each renter.
- **Then the game.** Steam logs each step of its sign-in in its own
  `logs/steamui_login.txt`. Once it logs `Success`, the agent runs
  `steam -applaunch <appid>`. It then waits for gamescope to put that game on screen
  (`GAMESCOPE_FOCUSED_APP`). Every event carries the time since Play (`src/login.ts`).
- **On the page.** Ignition shows the code in the dial's place while the play's own
  renter session (`web/src/swiff/play.ts`) carries it. On a rental-mode PC (the claim's
  `rentalMode`: swiff-hostd registered with `rental: true`, or on an attested host
  certificate) the session starts only on a frame after `signed-in`, so sign-in time is
  not billed. The launch is not called slow
  while a code is up, and the stream shows only on `game-started`, once the game is on
  screen. On `failed` (reason `sign-in-timeout`, or none) it offers Try again, which
  sends `steam-login retry` to the PC for a new code on the same claim, beside
  Ignition's Cancel, until the claim's sign-in time runs out
  ([`renter.md`](../docs/system-design/renter.md), "Playing"). On `launch-timeout` (the game never came up after sign-in) it says
  the game didn't start and offers Try another machine instead. A retry made while the room is
  reconnecting or the PC is away is held and sent once the PC is back, until it answers.

```bash
npm test -w @swiff/steam-login                            # unit tests
SWIFF_STEAM_SOCKET=/tmp/login.sock node swiff-os/steam/src/main.ts   # on an X display, with Steam installed
```

From a checkout the agent runs as TypeScript source on Node 22.18 or later. The image runs
it as one bundled file, `/usr/lib/swiff/steam/swiff-steam-login.mjs` (`npm run build -w
@swiff/steam-login`, staged by `image/stage.sh`), with `steam/session` as the renter
session. The image has what it needs: `steam`, `xwininfo`, `xprop`, `xwd` (x11-utils,
x11-apps) and `zbarimg` (zbar-tools). Its socket directory, `/run/swiff/steam`, is the
renter's with the streamer's group (2750), and the streamer gets `--steam-socket
/run/swiff/steam/login.sock` from swiff-hostd's config, with `SWIFF_APPID` set once the
agent knows the game booked.

### Measured in a VM

The VM ran Ubuntu 26.04 (the image's release) with OVMF Secure Boot, 2 vCPUs and 2 GB
of RAM, under QEMU 8.2 with no GPU. Steam ran for real and showed its real sign-in QR
code.

| Step                                                                                                              | Time                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Play to the first `qr` event on the socket (11 Plays)                                                             | 42–621 ms, median 58 ms                     |
| Renter joins the room to the code on their socket, via the real signaling server and a stand-in streamer (5 runs) | 0.28–0.42 s; 1.9 and 3.6 s on a loaded host |
| Steam start to its sign-in code, client already installed (4 runs)                                                | 26–133 s, before the PC is offered          |
| First Steam start on an empty home (download and update)                                                          | 157 s                                       |

The code Ignition draws decoded back, with zbar, to exactly Steam's link: 3 of 3
codes, 29 modules each. The rest of Play-to-first-frame could not run in the VM:

- **gamescope.** Version 3.16 needs a GPU whose Vulkan driver reports its DRM device
  (`VK_EXT_physical_device_drm`), headless or nested. Software Vulkan (lavapipe) does not,
  and QEMU 8.2 has no Vulkan passthrough. So Steam ran on plain Xvfb, which covers
  everything above except gamescope's focus check.
- **The renter's approval.** It needs a real Steam account and its phone.

Both wait for the Stage 0 run on a real host with the owner present. That run measures
the approval to `signed-in` (and checks the `Success` line), the launch to
`game-on-screen`, and so the full Play-to-first-frame.

### Not yet here

- **Play-to-first-frame** on real GPU hardware with a real Steam account, in a
  supervised session with the captain at the PC.
- **The Steam client installed outside the wiped home.** The image runs `steam/session`
  as the renter session, but Steam's client is fetched into the renter's home on each
  boot: every boot would show Ubuntu's installer prompt and then download Steam for about
  2.5 minutes, before the PC is offered. It moves to the sealed state partition with
  attestation (stage 3).
- **Which city to expect.** The report wants the page to say which city Steam's map
  should show, as a phishing check, but the platform has no host location yet.
- **Phone-only renters** (D7's fallback: password and phone approval through the
  stream).

This part does not depend on the two open decisions, D3 (hardware floor) and D8 (the
owner takes the PC back only when it is idle).
