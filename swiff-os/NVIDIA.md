# NVIDIA in Swiff OS

Swiff OS runs NVIDIA cards from the GeForce GTX 16 and RTX 20 series (Turing) on, with NVIDIA's
open kernel modules as Canonical builds and signs them. **Swiff never ships, bundles or mirrors
NVIDIA's proprietary driver.** The owner installs it on their own PC from the host app: they read
NVIDIA's licence, accept it and Swiff's terms, and the driver comes straight from Ubuntu's
archive onto their games drive. Swiff OS checks every byte of it at each boot before it loads
any of it. Everything here was checked against the image's pinned archive snapshot
(`20261001T000000Z`) without NVIDIA hardware. The [hardware test](#hardware-test) is what is
left, and until it passes NVIDIA stays off in the released host app.

## What the image carries, and what the owner installs

| Part                                                                         | Where it comes from                                                    | Licence                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| Open kernel modules (`nvidia`, `-modeset`, `-drm`, `-uvm`), signed           | **In the image**: Canonical's `linux-modules-nvidia-595-open-<kernel>` | Dual MIT/GPL-2            |
| egl-wayland, libpciaccess, the OpenCL loader (what NVIDIA's packages need)   | **In the image**: Ubuntu's packages                                    | MIT, MIT, BSD-2           |
| nouveau and nova blacklisted, `nvidia_drm modeset=1`                         | **In the image**: Swiff's own `/usr/lib/modprobe.d/swiff-nvidia.conf`  | Swiff's                   |
| The pinned list of NVIDIA's packages and their SHA-256                       | **In the image**: `/usr/lib/swiff/nvidia-driver`                       | Swiff's (hashes, no code) |
| GSP firmware, GL/EGL/Vulkan (64- and 32-bit), GBM, NVENC, CUDA, `nvidia-smi` | **The owner installs**: 10 packages, 339 MB, from Ubuntu's archive     | NVIDIA's driver licence   |

The open modules are unpacked from Canonical's package on their own (`mkosi.postinst.chroot`):
installing the package would pull in NVIDIA's proprietary firmware and userspace. Its `.ko`
files are built from NVIDIA's open source and carry no NVIDIA binary. The package's own
copyright file reproduces NVIDIA's licence because the source package covers both, and the image
drops `/usr/share/doc`. linux-firmware's NVIDIA firmware (for nouveau) is removed too
(`mkosi.finalize`). The build fails if any NVIDIA driver package, library, firmware or
`nvidia-smi` is in the image.

595 is the newest series Ubuntu also ships as a `-server` twin, its sign of a production
branch. The image's root does not grow for NVIDIA; the owner's driver takes 339 MB on the games
drive, and about 1.1 GiB of the 6.4 GiB per-boot scratch while Swiff OS runs.

## How the owner installs it

On the Rental mode screen (`desktop/src/screens/Rental.tsx`, `desktop/nvidia.cjs`), for a card
Swiff OS runs:

1. The app loads **NVIDIA's licence for this release as Ubuntu publishes it**
   (changelogs.ubuntu.com, the `copyright` file of `nvidia-graphics-drivers-595`) and shows it
   only if its SHA-256 is the one pinned in the manifest: the same text the driver package
   carries, which Swiff OS checks again at boot.
2. The owner ticks **"I have read NVIDIA's licence and accept it"** and, after reading Swiff's
   terms for NVIDIA cards (below), **"I accept these terms"**. One button installs.
3. The app records the acceptance in its own data folder (`nvidia-acceptance.json`: driver
   release, licence URL and SHA-256, terms version, time), then downloads each package from
   `snapshot.ubuntu.com` onto `<games drive>:\SwiffOS\nvidia\595.91.07\`, through Chromium's
   network stack (the PC's proxy settings). Each package is checked against its SHA-256 before it
   takes its name; one already there and whole is kept, so a stopped install picks up again.
4. Failures say what to do: no connection, Ubuntu no longer has the file (a Swiff Host update
   brings the current one), server error, not the expected bytes (nothing kept), no room on the
   drive (how much), the drive cannot be written, stopped by the owner.
5. Once installed, the screen says what is on which drive and when the owner accepted, and
   **Remove it** deletes the folder and the acceptance.

The manifest the app uses (`desktop/swiff-os-nvidia-driver`) is the image's, byte for byte
(`desktop/src/nvidia.test.ts`).

## How Swiff OS loads it

`swiff-nvidia.service` runs `/usr/libexec/swiff/nvidia` at every boot, before the renter's
session:

- No NVIDIA display controller: nothing happens (`state=no-card` in `/run/swiff/nvidia`).
- No driver folder on the games drive: `state=not-installed`.
- Otherwise each package is copied to the encrypted scratch and the copy is checked against its
  size and SHA-256 in the manifest the verity root pins. The games drive is Windows', and Windows
  can write it: anything missing or different is refused and nothing is loaded
  (`state=refused`, with the file named). The licence inside the driver must be the one the app
  showed.
- The packages are unpacked on the scratch, normalised to the merged `/usr` (`/lib`, `/sbin`
  move under `/usr`; `/etc`, suspend and power units are left out) and merged over `/usr` as a
  system extension (`systemd-sysext`), so libraries, firmware, ICD files and udev rules sit where
  Ubuntu's packages put them.
- Then the image's own modules load by name. udev never loads `nvidia` before this
  (`blacklist nvidia` in `swiff-nvidia.conf`), because its GSP firmware comes with the owner's
  driver. NVIDIA's `ub-device-create` makes `/dev/nvidia*`. `state=ready` once
  `/proc/driver/nvidia/version` is the manifest's release.

Checked locally against the real 595.91.07 packages (paths remapped, root-only steps stubbed):
all ten match, the unpack takes about 9 s and 1.1 GiB, the firmware, GL, EGL, Vulkan, GBM,
NVENC, CUDA and udev files land where expected; a missing package and a one-byte change are each
refused.

## Why the modules load under lockdown

The kernel runs with `lockdown=confidentiality` and `module.sig_enforce=1`, so it loads only
modules signed by a key it trusts. Swiff does not sign NVIDIA's modules:

- `modinfo` on each `.ko` in `linux-modules-nvidia-595-open-7.0.0-34-generic` gives signer
  `Canonical Ltd. Kernel Module Signing`, key serial `E9:DF:13:0F:92:92:A9:B7`, SHA-512.
- That certificate is built into the image's kernel (its builtin trusted keys), next to
  Canonical's 2025 module-signing key. It is Canonical's 2016 key and its validity ended
  29 May 2026; the kernel does not check certificate dates when it verifies a module, and the
  VM test proves the module is accepted.

The build checks every time (`mkosi.finalize`): exactly one kernel, an open `nvidia.ko` built
for it and signed by Canonical, its release the manifest's, and none of NVIDIA's proprietary
driver in the image. `mkosi.postinst.chroot` asks apt what NVIDIA's packages resolve to for this
image (nothing is installed); `mkosi.finalize` fails unless that is exactly the manifest's list,
and prints the lines to put in both copies. A snapshot bump where NVIDIA's packages, the module
release or a dependency move fails loudly instead of shipping a mismatch.

The VM test (`vm/run-test.sh`, run in CI) adds, under Secure Boot with lockdown: `modprobe
nvidia` passes the signature check and then stops at "No such device" (no NVIDIA card in the
VM), the same module with its signature cut off is refused ("Key was rejected by service"), none
of NVIDIA's proprietary driver is in the image, the boot reports `no-card`, the checker refuses
missing packages and packages of the right size with the wrong bytes, nouveau and nova are
blacklisted, `nvidia` waits for its driver, and `nvidia_drm modeset=1` is set.

## Which cards

NVIDIA's `supported-gpus.json` in `nvidia-kernel-common-595` lists 831 chips the 595 driver
supports. Every one supports the open modules, and the lowest PCI device number is 0x1E02 (TITAN
RTX, Turing). Every card below 0x1E00 (GTX 10 series and older) is on a legacy branch (580 or
earlier). So the rule is one comparison: an NVIDIA card with PCI device number 0x1E00 or above
runs. That includes the GTX 16 series (Turing without RT cores, for example 0x2184, GTX 1660)
and laptop MX450/MX550.

The host app reads the device number from Windows (`Win32_VideoController.PNPDeviceID`, no
administrator rights) and holds an older card against the PC (`desktop/src/rental.ts`,
`nvidiaSupported`; `desktop/nvidia.cjs`, `supportedCard`, which the install also checks). An
older card gets "Fit a GeForce GTX 16 or RTX 20 series card or newer", and is told sharing from
Windows works as before.

## Two switches: the hardware test, and Swiff's own

- **The hardware test.** Until it passes, the released app shows a card Swiff OS runs as "in
  testing", offers no driver and no install. Starting the app with `--nvidia-rental` (main.cjs)
  lifts that, for the test. When the test passes, drop the flag and make it the default.
- **The server's `NVIDIA_RENTAL`** (`server/src/attestation.ts`, default `off`) turns NVIDIA
  hosting in Swiff OS off for everyone at once, without an app update: attest refuses a machine
  that says it hosts on an NVIDIA card (`nvidia-rental-off`), and a host certificate minted for
  one hosts nothing, so its running session stops. `GET /api/hosting` tells the host app, which
  then shows the card as "paused" and offers no driver. Sharing from Windows is not affected.
  Turn it on only after the hardware test. swiff-hostd's attestation client (not built yet) must
  send `graphics: "nvidia"` when NVIDIA's driver runs the card (`/run/swiff/nvidia`
  `state=ready`).

Nothing in Swiff's apps or pages says "earn with your NVIDIA card".

## gamescope and explicit sync

gamescope on NVIDIA needs explicit sync (the `linux-drm-syncobj-v1` Wayland protocol), which
NVIDIA added in driver 555 together with Xwayland 24.1 and egl-wayland 1.1.14:

| Part        | Needed                                   | Where                                                                 |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------- |
| NVIDIA      | 555 or later                             | 595.91.07, the owner's install (the manifest and the image's modules) |
| Xwayland    | 24.1 or later                            | 24.1.10 in the image (its binary has the DRI3 syncobj path)           |
| egl-wayland | 1.1.14 or later                          | 1.1.21 in the image (`libnvidia-egl-wayland1`, MIT)                   |
| gamescope   | speaks `wp_linux_drm_syncobj_manager_v1` | 3.16.20 in the image: its binary implements it                        |
| nvidia-drm  | KMS on                                   | `options nvidia_drm modeset=1` (`swiff-nvidia.conf`)                  |

`mkosi.finalize` fails the build if a snapshot bump drops any of these below the line.

## The streamer: NVENC

`streamer/src/gpu.ts` reads the PC's cards from `/sys/class/drm/card*` (vendor and bound
driver). With an NVIDIA card that NVIDIA's driver runs, the streamer tries NVENC first, then
VA-API, then x264; without one it never tries NVENC. Each encoder still has to pass its check on
a few frames before the stream depends on it. The NVENC chain is GStreamer 1.28's `nvh264enc`:
`cudaupload ! cudaconvertscale` (colour conversion and scaling on the GPU) ! `nvh264enc preset=p1
tune=ultra-low-latency rc-mode=cbr zerolatency=true bframes=0` with a VBV of one frame. It needs
`libnvidia-encode` and `libcuda` from the owner's driver. The streamer is not in the image yet;
when it lands it needs `gstreamer1.0-plugins-bad` (nvcodec).

## Building it

`.github/workflows/swiff-os-image.yml` builds the image on a GitHub runner whenever
`swiff-os/image/`, `swiff-os/vm/` or the workflow change, and boots it twice under Secure Boot
with swtpm (`vm/run-test.sh`), on the runner's KVM. The Secure Boot key is a throwaway the test
makes per run; no secret is involved. The CI build does not keep the image yet (it is about
3 GB); uploading it as a short-lived workflow artifact is a follow-up.

## Licence

**Captain's decision (6 Oct 2026), after the legal report:** shift the installation to the host.
Swiff does not distribute NVIDIA's driver; each owner installs it on their own PC from Ubuntu
and accepts NVIDIA's licence themselves. The remaining risk is the captain's accepted risk, not
a blocker; NVIDIA hosting stays off until the hardware test passes, and the server switch can
stop it at any time.

Sources: NVIDIA Driver License Agreement as shipped in the 595 packages and as Ubuntu publishes
it (the `copyright` file pinned in the manifest), and as NVIDIA publishes it,
<https://www.nvidia.com/en-us/drivers/nvidia-license/> (v. 25 February 2025); NVIDIA's open
kernel modules, <https://github.com/NVIDIA/open-gpu-kernel-modules> (dual MIT/GPL-2);
Canonical's IP rights policy, <https://canonical.com/legal/intellectual-property-policy>
(15 July 2015).

- **No redistribution by Swiff.** The image carries the open modules (MIT/GPL) and SHA-256
  hashes; the proprietary driver comes from Ubuntu's archive to the owner's PC, and the owner is
  the licensee. Swiff's servers never hold or relay it.
- **The owner accepts NVIDIA's licence themselves**, on the exact text of the release they
  install, recorded with release and time.
- **Swiff's terms for NVIDIA cards** (`desktop/src/nvidia.ts`, `NVIDIA_TERMS`, version
  `2026-10-06` in `desktop/nvidia.cjs`), shown and accepted beside NVIDIA's licence: the owner
  installs the driver and accepts NVIDIA's licence with NVIDIA; the PC and card are theirs, at
  home, hosting as a private person, not from a data centre or as a business; they hold the
  licences the PC needs to host; if they break the terms and a third party holds Swiff liable,
  they cover Swiff's reasonable costs unless they were not at fault, and their consumer rights
  stay as they are; Swiff can pause NVIDIA hosting for everyone, and the owner can stop and
  remove the driver at any time. **Draft wording, marked for the lawyer's check**: it is written
  to hold for an EU consumer (a broad indemnity from a consumer would be an unfair term), so the
  cost cover is fault-based and limited.

**For counsel** (not decided here):

1. **Section 2.7: "you may not sell, rent, sublicense, distribute or transfer the SOFTWARE or
   provide commercial hosting services with the SOFTWARE"**. With the owner installing, Swiff no
   longer distributes; whether an owner renting their PC's time through Swiff is "commercial
   hosting services" by the owner (and whether Swiff facilitates it) is the open question. The
   same agreement governs the GeForce driver owners already run under Windows when they host
   today.
2. **Section 2.8: GeForce software "is licensed for use only on GeForce or Titan hardware
   products you own, and … is not licensed for datacenter deployment."** The terms make owners
   confirm the card is theirs and the PC is at home; counsel should confirm a home PC rented
   out is not a "datacenter deployment".
3. **The terms themselves**: the warranty and the fault-based cost cover under German and EU
   consumer law (AGB control, Unfair Terms Directive), and whether they need to be part of the
   general host terms rather than a separate acceptance.
4. **Canonical's IP policy.** Modified versions of Ubuntu may be redistributed without
   Canonical's approval only with Ubuntu's trademarks removed, and the policy speaks of
   recompiling to create your own binaries, while saying it does not limit rights under open
   source licences. Swiff OS redistributes Ubuntu's binaries, including Canonical's signed NVIDIA
   open modules (a rebuild loses Canonical's signature, so Swiff would need its own kernel with
   its own key built in). This applies to the whole image. Needs a legal read, or an agreement
   with Canonical.

## Hardware test

Needs, before it can run:

- **A test PC** with UEFI, Secure Boot (with Microsoft's third-party UEFI CA), TPM 2.0, an
  IOMMU, 24 GB of free disk, a Steam library on an NTFS games drive without BitLocker, and a wired
  network.
- **NVIDIA cards.** At least one Ampere or Ada card, for example an RTX 3060 or RTX 4060 (the most
  common in German gaming PCs; GSP firmware `gsp_ga10x.bin`). Ideally also a Turing card, an RTX
  2060 or GTX 1660 (the oldest supported, `gsp_tu10x.bin`), and a GTX 10 series card to see the
  host app hold it back.
- **Driver and modules**: NVIDIA 595.91.07 (Ubuntu `595.91.07-0ubuntu0.26.04.1`) installed by the
  host app, and the image's Canonical-signed open modules for kernel 7.0.0-34-generic
  (`7.0.0-34.34+1`), from the pinned snapshot.
- **A display** on the card (monitor or HDMI/DP dummy plug), and once without one, to learn
  whether gamescope needs a connector.
- **The image on the PC**, built by hand or from CI and copied over, installed with the host
  app's install (or a USB copy of `swiffos.raw`), Swiff's key confirmed at MokManager.
- **A renter** on another network: a browser on the `/rtc` page, and a Steam account with the
  games below.

Checks, in order:

1. **The host app installs the driver.** Started with `--nvidia-rental`: the card shows "needs
   NVIDIA's driver"; the licence loads from Ubuntu; Install stays off until both boxes are ticked;
   the download shows progress, survives Stop and a second start (keeps what is whole), and
   lands 10 packages, 339 MB, in `<games>:\SwiffOS\nvidia\595.91.07\`; the card then shows
   ready with the acceptance date; `nvidia-acceptance.json` holds release, licence hash, terms
   version and time. Without the flag the card shows "in testing" and offers nothing; with the
   server's `NVIDIA_RENTAL=off` it shows "paused".
2. **Checked and loaded under Secure Boot.** `/run/swiff/nvidia` says `state=ready`;
   `journalctl -u swiff-nvidia` shows the check and how long the unpack took (target under 30 s);
   `mokutil --sb-state` enabled; `/sys/kernel/security/lockdown` is `[confidentiality]`; `lsmod`
   shows `nvidia`, `nvidia_modeset`, `nvidia_drm`, `nvidia_uvm` and no nouveau; `journalctl -k`
   has no "module verification failed", "Key was rejected" or GSP firmware errors;
   `/proc/driver/nvidia/version` is 595.91.07; `/sys/module/nvidia_drm/parameters/modeset` is
   `Y`; `/dev/nvidia*` exist and the renter (uid 1000) and `swiff-stream` can open them;
   `systemd-sysext status` lists `swiff-nvidia`; `nvidia-smi` lists the card with its GSP firmware
   version. Then change one byte of one package on the games drive from Windows: the next boot
   says `state=refused` naming it, and loads nothing.
3. **gamescope session.** `swiff-session.service` active with no restarts over 10 minutes;
   gamescope's log shows the NVIDIA Vulkan device and "Supports Explicit Sync: true"; Steam's big
   picture UI on the display; the hardware floor in `/run/swiff/hardware-floor` passes.
4. **NVENC.** The streamer logs `graphics: nvidia (nvidia)` and `encoding with nvenc`; a 10-minute
   1080p60 session at 10 Mbit/s; encode latency per frame with GStreamer's latency tracer
   (`GST_TRACERS=latency`) from `pipewiresrc` to `rtph264pay`, target under 5 ms; `nvidia-smi
--query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency
--format=csv` during the session; the streamer's CPU use; glass-to-glass time at the renter (a
   millisecond clock on screen, filmed beside the renter's view); the renter decodes
   constrained-baseline H.264 without errors.
5. **A Proton game and a native one.** A Proton DX12 game through VKD3D-Proton (for example
   Warframe, free) and a native Vulkan one (Counter-Strike 2): starts, plays for 15 minutes, frame
   rate at the renter, no gamescope or driver errors in the journal; Steam's sandbox
   (pressure-vessel) finds the NVIDIA libraries, 32-bit included.
6. **Clean between renters.** End the session: the PC reboots, the driver is checked and loaded
   again, and the next renter's session starts on the same driver.
7. **Remove.** "Remove it" in the host app deletes the folder; the next boot says
   `state=not-installed` and the session does not start on the card.
