# NVIDIA in Swiff OS

Swiff OS runs NVIDIA cards from the GeForce GTX 16 and RTX 20 series (Turing) on, with NVIDIA's
open kernel modules as Canonical builds and signs them. Everything here was checked against the
image's pinned archive snapshot (`20261001T000000Z`) without NVIDIA hardware. The
[hardware test](#hardware-test) is what is left.

## What the image carries

| Part                                                                       | Package (Ubuntu 26.04, restricted)                 | Version       |
| -------------------------------------------------------------------------- | -------------------------------------------------- | ------------- |
| Kernel modules (nvidia, -modeset, -drm, -uvm)                              | `linux-modules-nvidia-595-open-generic`            | 7.0.0-34.34+1 |
| GSP firmware the open modules load                                         | `nvidia-firmware-595-595.91.07` (dependency)       | 595.91.07     |
| GL, EGL, Vulkan, 64- and 32-bit                                            | `libnvidia-gl-595`, `libnvidia-gl-595:i386`        | 595.91.07     |
| GBM backend (gamescope needs it)                                           | `libnvidia-extra-595`                              | 595.91.07     |
| NVENC and CUDA (the streamer)                                              | `libnvidia-encode-595` (pulls `libnvidia-compute`) | 595.91.07     |
| `nvidia-smi`                                                               | `nvidia-utils-595`                                 | 595.91.07     |
| nouveau and nova blacklisted, `nvidia_drm modeset=1`, device nodes by udev | `nvidia-kernel-common-595` (dependency)            | 595.91.07     |

595 is the newest series Ubuntu also ships as a `-server` twin, its sign of a production
branch, and the 590 metapackage already points to it. 610 is newer, only in `-updates`, and has
no server twin yet.

**Size.** The NVIDIA packages add 1,119 MiB installed (apt's `Installed-Size`, 64- and 32-bit,
including docs the image then drops). The read-only root grows from about 2.0 GiB to about
3.1 GiB of its 8 GiB slot. The ESP and the UKI do not change: the initrd carries no NVIDIA
module. The CI build reports the measured root size in its summary.

## Why the modules load under lockdown

The kernel runs with `lockdown=confidentiality` and `module.sig_enforce=1`, so it loads only
modules signed by a key it trusts. Swiff does not sign NVIDIA's modules:

- `modinfo` on each `.ko` in `linux-modules-nvidia-595-open-7.0.0-34-generic` gives signer
  `Canonical Ltd. Kernel Module Signing`, key serial `E9:DF:13:0F:92:92:A9:B7`, SHA-512.
- That certificate is built into the image's kernel: it is among the X.509 certificates
  compiled into `vmlinuz-7.0.0-34-generic` (the kernel's builtin trusted keys), next to
  Canonical's 2025 module-signing key. It is Canonical's 2016 key and its validity ended
  29 May 2026; the kernel does not check certificate dates when it verifies a module, and
  the VM test below proves the module is accepted.
- The modules are Canonical's builds of NVIDIA's open source (dual MIT/GPL-2), shipped
  already linked and signed, at `kernel/nvidia-595-open/`, so the image's ZFS clean-up in
  `mkosi.finalize` (which removes `ubuntu/`) leaves them alone.

The build checks this every time (`mkosi.finalize`): exactly one kernel, an open `nvidia.ko`
built for it, signed by Canonical, the userspace (64- and 32-bit) and the GSP firmware of the
same release, and NVIDIA's licence in the image. A snapshot bump where the NVIDIA metapackage
lags the kernel fails the build instead of shipping a second kernel.

The VM test (`vm/run-test.sh`, run in CI) adds, under Secure Boot with lockdown:
`modprobe nvidia` passes the signature check and then stops at "No such device" (the VM has no
NVIDIA card), the same module with its signature cut off is refused ("Key was rejected by
service"), the userspace and firmware are in place, nouveau and nova are blacklisted and
`nvidia_drm modeset=1` is set.

## Which cards

NVIDIA's `supported-gpus.json` in `nvidia-kernel-common-595` lists 831 chips the 595 driver
supports. Every one supports the open modules (`kernelopen`), and the lowest PCI device number
is 0x1E02 (TITAN RTX, Turing). Every card below 0x1E00 (GTX 10 series and older) is on a legacy
branch (580 or earlier). So the rule is one comparison: an NVIDIA card with PCI device number
0x1E00 or above runs. That includes the GTX 16 series (Turing without RT cores, for example
0x2184, GTX 1660) and laptop MX450/MX550.

The host app reads the device number from Windows (`Win32_VideoController.PNPDeviceID`,
no administrator rights) and holds an older card against the PC:
`desktop/src/rental.ts` (`nvidiaSupported`, `SWIFF_OS_NVIDIA`). Its Graphics row shows the card,
whether Swiff OS runs it and on which driver, and Windows' own driver version (for NVIDIA in
NVIDIA's numbering, `32.0.15.6094` → `560.94`). An older card gets "Fit a GeForce RTX 20 series
card or newer", and is told sharing from Windows works as before.

**NVIDIA stays off for owners until the hardware test passes.** A card Swiff OS will run shows
"in testing" ("NVIDIA support is in testing: Swiff OS will run it on NVIDIA's 595 driver") and
is not ready, so the install is not offered. Starting the app with `--nvidia-rental` (main.cjs)
takes such cards, for the hardware test. When the test passes, drop the flag and make taking
them the default.

## gamescope and explicit sync

gamescope on NVIDIA needs explicit sync (the `linux-drm-syncobj-v1` Wayland protocol), which
NVIDIA added in driver 555 together with Xwayland 24.1 and egl-wayland 1.1.14. The image has:

| Part        | Needed                                   | In the image                                                                   |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| NVIDIA      | 555 or later                             | 595.91.07                                                                      |
| Xwayland    | 24.1 or later                            | 24.1.10 (its binary has the DRI3 syncobj path)                                 |
| egl-wayland | 1.1.14 or later                          | 1.1.21 (`libnvidia-egl-wayland1`), plus egl-wayland2 inside `libnvidia-gl-595` |
| gamescope   | speaks `wp_linux_drm_syncobj_manager_v1` | 3.16.20: its binary implements it and logs "Supports Explicit Sync"            |
| nvidia-drm  | KMS on                                   | `options nvidia_drm modeset=1` (`nvidia-kernel-common-595`)                    |

`mkosi.finalize` fails the build if a snapshot bump drops any of these below the line.
Whether gamescope then runs the renter's session smoothly on a real card is the hardware test.

## The streamer: NVENC

`streamer/src/gpu.ts` reads the PC's cards from `/sys/class/drm/card*` (vendor and bound
driver). With an NVIDIA card that NVIDIA's driver runs, the streamer tries NVENC first, then
VA-API, then x264; without one it never tries NVENC (VA-API, then x264). Each encoder still has
to pass its check on a few frames before the stream depends on it. The NVENC chain is GStreamer
1.28's `nvh264enc` (the NVENC SDK 12 encoder): `cudaupload ! cudaconvertscale` (colour
conversion and scaling on the GPU) ! `nvh264enc preset=p1 tune=ultra-low-latency rc-mode=cbr
zerolatency=true bframes=0` with a VBV of one frame. The streamer is not in the image yet; when
it lands it needs `gstreamer1.0-plugins-bad` (nvcodec) beside the driver libraries above.

## Building it

The image with the driver no longer fits a small workstation build. `.github/workflows/swiff-os-image.yml`
builds it on a GitHub runner whenever `swiff-os/image/`, `swiff-os/vm/` or the workflow change,
and boots it twice under Secure Boot with swtpm (`vm/run-test.sh`), on the runner's KVM. The
Secure Boot key is a throwaway the test makes per run; no secret is involved.

## Licence

Sources: NVIDIA Driver License Agreement as shipped in the 595 packages
(`/usr/share/doc/nvidia-kernel-common-595/copyright`, kept in the image as
`/usr/share/swiff/licenses/nvidia-driver`) and as published,
<https://www.nvidia.com/en-us/drivers/nvidia-license/> (v. 25 February 2025); NVIDIA's open
kernel modules, <https://github.com/NVIDIA/open-gpu-kernel-modules> (dual MIT/GPL-2); Canonical's
IP rights policy, <https://canonical.com/legal/intellectual-property-policy> (15 July 2015).

- **Redistributing the driver in the image is allowed, with conditions.** Section 1.1(d)
  allows distributing the software "for use with operating system kernels distributed under the
  terms of an OSI-approved open source license", provided the binaries are not modified and
  "this Agreement is provided to each SOFTWARE recipient". The image ships the packages
  unmodified and keeps the agreement's text (`mkosi.finalize` fails without it).
- **The kernel modules are open source.** Canonical's builds of NVIDIA's open modules are dual
  MIT/GPL-2. Their source, like the kernel's, is in Ubuntu's archive.
- **Firmware.** The GSP firmware is under NVIDIA's agreement: only for use on NVIDIA hardware
  (section 2.1), which is the only place it loads.

**For counsel** (not decided here):

1. **Section 2.7: "you may not sell, rent, sublicense, distribute or transfer the SOFTWARE or
   provide commercial hosting services with the SOFTWARE"**, "except as expressly granted".
   Owners renting their PC's time to strangers through Swiff could be read as commercial
   hosting with the driver. The same agreement governs the GeForce driver owners already run
   under Windows when they host today, so this is not new with Swiff OS, but rental mode makes
   Swiff the distributor. Needs a legal read, and possibly a conversation with NVIDIA.
2. **Section 2.8: GeForce software "is licensed for use only on GeForce or Titan hardware
   products you own, and … is not licensed for datacenter deployment."** Owners own their cards
   and the PCs are in homes, which fits; counsel should confirm a home PC rented out is not a
   "datacenter deployment".
3. **How the agreement reaches each recipient** (1.1(d)(ii)). The text is in the image; counsel
   should say whether the host app must also show it (for example at install), and whether the
   owner or the renter is the recipient.
4. **Canonical's IP policy.** Modified versions of Ubuntu may be redistributed without
   Canonical's approval only with Ubuntu's trademarks removed, and the policy says one "will
   need to recompile the source code to create your own binaries", while also saying it does
   not limit rights under open source licences. Swiff OS redistributes Ubuntu's binaries, and
   for NVIDIA the point is precisely to use Canonical's signed binaries (a rebuild loses
   Canonical's signature, so Swiff would need its own kernel with its own key built in). This
   applies to the whole image, not only NVIDIA. Needs a legal read, or an agreement with
   Canonical.

## Hardware test

Needs, before it can run:

- **A test PC** with UEFI, Secure Boot (with Microsoft's third-party UEFI CA), TPM 2.0, an
  IOMMU, 24 GB of free disk and a wired network. The GEEKOM serves only if it has an NVIDIA
  card of the generations below.
- **NVIDIA cards.** At least one Ampere or Ada card, for example an RTX 3060 or RTX 4060 (the
  most common in German gaming PCs; GSP firmware `gsp_ga10x.bin`). Ideally also a Turing card,
  an RTX 2060 or GTX 1660 (the oldest supported, `gsp_tu10x.bin`), and a GTX 10 series card to
  see the host app hold it back.
- **A display** on the card (monitor or HDMI/DP dummy plug), and once without one, to learn
  whether gamescope needs a connector.
- **The image on the PC.** The CI build keeps no image (it is about 3.5 GB); a build host or a
  manual workflow run that uploads it is needed, then the host app's install (or a USB copy of
  `swiffos.raw`) and Swiff's key confirmed at MokManager.
- **A renter** on another network: a browser on the `/rtc` page, and a Steam account with the
  games below.

Checks, in order:

1. **Modules under Secure Boot.** `mokutil --sb-state` enabled;
   `/sys/kernel/security/lockdown` is `[confidentiality]`; `lsmod` shows `nvidia`,
   `nvidia_modeset`, `nvidia_drm`, `nvidia_uvm`; no nouveau; `journalctl -k` has no "module
   verification failed" or "Key was rejected"; `/proc/driver/nvidia/version` is 595.91.07;
   `/sys/module/nvidia_drm/parameters/modeset` is `Y`; `/dev/nvidia*` exist and the renter
   (uid 1000) and `swiff-stream` can open them; `nvidia-smi` lists the card with its GSP
   firmware version.
2. **gamescope session.** `swiff-session.service` active with no restarts over 10 minutes;
   gamescope's log shows the NVIDIA Vulkan device and "Supports Explicit Sync: true"; Steam's
   big-picture UI on the display; the hardware floor in `/run/swiff/hardware-floor` passes.
3. **NVENC.** The streamer logs `graphics: nvidia (nvidia)` and `encoding with nvenc`; a
   10-minute 1080p60 session at 10 Mbit/s; encode latency per frame with GStreamer's latency
   tracer (`GST_TRACERS=latency`) from `pipewiresrc` to `rtph264pay`, target under 5 ms;
   `nvidia-smi --query-gpu=encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency --format=csv`
   during the session; the streamer's CPU use; glass-to-glass time at the renter (a
   millisecond clock on screen, filmed beside the renter's view); the renter decodes
   constrained-baseline H.264 without errors.
4. **A Proton game and a native one.** A Proton DX12 game through VKD3D-Proton (for example
   Warframe, free) and a native Vulkan one (Counter-Strike 2): starts, plays for 15 minutes,
   frame rate at the renter, no gamescope or driver errors in the journal; Steam's sandbox
   (pressure-vessel) finds the NVIDIA libraries.
5. **Clean between renters.** End the session: the PC reboots, the modules load again, and the
   next renter's session starts on the same driver.
6. **The host app.** Without `--nvidia-rental` a supported card shows "in testing" and offers no
   install; with it, the card is ready and the install is offered. With a GTX 10 series card the
   app shows "too old" and offers no install either way.
