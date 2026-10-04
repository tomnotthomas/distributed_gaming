# Swiff OS

Swiff OS is the rental mode for host PCs: a locked Linux system that a host PC boots into while it is
shared. The renter's Steam session runs on an immutable, measured OS that the owner has no admin rights
on. The design is in the rental-mode report (§5–§8, staged plan in §11). This directory is built up
stage by stage.

| Directory | What it is                                                                    |
| --------- | ----------------------------------------------------------------------------- |
| `image/`  | The mkosi build of the Swiff OS image (stage 1)                               |
| `vm/`     | The VM test: builds the image and boots it under Secure Boot with a TPM       |
| later     | `hostd/` (session agent), `streamer/` (capture and input), attestation client |

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

- **Shim and MOK on real hardware.** Real PCs boot through a distribution shim with MOK enrolment
  (stage 1 in the report) and, later, Swiff's own shim. The VM enrols the test key directly instead.
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
