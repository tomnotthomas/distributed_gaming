#!/usr/bin/env bash
# Lanterel OS session test: a renter plays on a PC in rental mode, end to end.
#
# Builds the image's session test variant (mkosi --profile=sessiontest: the
# shipped image plus vm/sessiontest/), then runs vm/session-harness.mjs in a
# network namespace of its own, where the real server and a TURN relay have
# addresses that look public to the VM. The harness boots the image in
# QEMU/KVM under OVMF with Secure Boot and a software TPM, and follows it:
# swiff-hostd attests with the image's attestation client to the server's TPM
# verifier, opens its persistent state and offers the PC; a renter on the
# hosted site (headless Chromium) holds Launch, sees Steam's sign-in code on
# Ignition, plays the game on the path ICE picks, reloads, reconnects and ends the
# session; swiff-hostd restarts the PC clean, attests again, reopens the same
# state and offers it again; booted once more with a kernel command line from
# outside its signed UKI, the PC is refused attestation and never offered. Each
# step is reported PASS or FAIL. The server trusts this build's boot: PCR 11 as
# systemd-measure (vm/measure-uki.py, in the build's tools tree) predicts it
# for the UKI.
#
# Steam (no account, no network here) and gamescope (no GPU) are stood in for
# (vm/sessiontest/); everything else is the shipped image's.
#
#   swiff-os/vm/session-test.sh             build the image if what goes into it
#                                           changed (vm/build-image.sh), then run the test
#   swiff-os/vm/session-test.sh --rebuild   build the image anyway
#   swiff-os/vm/session-test.sh --no-build  run it on the last build
#
# SWIFF_SESSION_RELAY_ONLY=1 puts the renter's browser behind a home router of
# its own, on a private address the image's firewall refuses, so the stream
# can come only through the relay. By default ICE picks the path.
#
# Build output, caches and the run's files go to $SWIFF_OS_BUILD_DIR (default
# ~/.cache/swiff-os), the run in session-vm/. It touches nothing of this PC
# but those: no disks, boot entries or firmware variables.
#
# Needs: sudo (mkosi 20 builds as root), qemu-system-x86_64 with /dev/kvm usable
# by this user, swtpm and swtpm-tools (swtpm_setup, swtpm_localca, gnutls's
# certtool), OVMF (/usr/share/OVMF), unshare (user and network
# namespaces), mkfs.ext4, coturn's turnserver (TURNSERVER=path, else on PATH)
# and Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or npx playwright install
# chromium-headless-shell). The VM gets 2 GiB of RAM and 4 vCPUs ($SWIFF_VM_CPUS)
# and starts through vm/vm-run.py, which waits for room among this PC's test
# VMs and stops the VM when it hangs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/$(basename "$0")
image_dir=$(cd "$here/../image" && pwd)
repo=$(cd "$here/../.." && pwd)
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=$build_dir/output
run=$build_dir/session-vm

# Prints an error and exits.
die() {
	echo "session-test: $*" >&2
	exit 1
}

if [ "${SWIFF_SESSION_INSIDE:-}" = 1 ]; then
	# The namespace's own network: the server and the relay on addresses the
	# VM's firewall treats as the internet. QEMU's user network reaches them.
	ip link set lo up
	ip addr add 198.51.100.10/32 dev lo
	ip addr add 198.51.100.20/32 dev lo
	exec node "$here/session-harness.mjs" --run "$run" --image "$SWIFF_SESSION_IMAGE"
fi

build=1
for arg in "$@"; do
	case $arg in
	--no-build) build=0 ;;
	--rebuild) build=2 ;;
	*)
		echo "usage: $0 [--no-build|--rebuild]" >&2
		exit 2
		;;
	esac
done

for tool in qemu-system-x86_64 qemu-img swtpm swtpm_setup swtpm_localca mkosi unshare; do
	command -v "$tool" > /dev/null || die "$tool not found"
done
[ -w /dev/kvm ] || die "/dev/kvm is not usable by $(id -un)"
[ -r /usr/share/OVMF/OVMF_CODE_4M.secboot.fd ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
TURNSERVER=${TURNSERVER:-$(command -v turnserver || true)}
[ -x "$TURNSERVER" ] || die "coturn's turnserver not found: install coturn, or set TURNSERVER"
export TURNSERVER

# One run at a time, from before the build: a second one would rebuild the
# image and the server under a run that is using them. The lock's descriptor
# is inherited through both execs below, so it covers the namespaced run too.
mkdir -p "$build_dir"
exec 9> "$build_dir/session-vm.lock"
flock -n 9 || die "another session-test.sh is running"

if [ "$build" = 0 ]; then
	SWIFF_SESSION_IMAGE=$out/swiffos-sessiontest.raw
else
	SWIFF_SESSION_IMAGE=$("$here/build-image.sh" sessiontest $([ "$build" = 2 ] && echo --rebuild)).raw
fi
# The build's UKI is next to its disk.
uki=${SWIFF_SESSION_IMAGE%.raw}.efi
[ -e "$SWIFF_SESSION_IMAGE" ] && [ -e "$uki" ] || die "$SWIFF_SESSION_IMAGE or $uki not built"
export SWIFF_SESSION_IMAGE

# What PCR 11 holds once the UKI has booted to `ready`: the release's in the boot policy.
tools=$out/ubuntu-tools
SWIFF_SESSION_PCR11=$(bwrap --ro-bind "$tools/usr" /usr \
	--symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
	--ro-bind "$uki" /uki.efi --ro-bind "$here/measure-uki.py" /measure-uki.py \
	--proc /proc --dev /dev --tmpfs /tmp \
	python3 /measure-uki.py /uki.efi) || die "systemd-measure could not predict PCR 11 for the UKI"
export SWIFF_SESSION_PCR11

echo "== building the server and the web app"
(cd "$repo" && npm run build) > /dev/null

# The run's files hold a machine key and the VM's state: this user's alone.
umask 077
mkdir -p "$run"
chmod 700 "$run"
echo "== running the test in a network namespace of its own; the run's files are in $run"
exec env SWIFF_SESSION_INSIDE=1 unshare --user --map-root-user --net "$script" "$@"
