#!/usr/bin/env bash
# Lanterel OS session test: a renter plays on a PC in rental mode, end to end.
#
# Builds the image's session test variant (mkosi --profile=sessiontest: the
# shipped image plus vm/sessiontest/), then runs vm/session-harness.mjs in a
# network namespace of its own, where the real server and a TURN relay have
# addresses that look public to the VM. The harness boots the image in
# QEMU/KVM under OVMF with Secure Boot and a software TPM, and follows it:
# swiff-hostd attests, opens its persistent state and offers the PC; a renter on
# the hosted site (headless Chromium) holds Launch, sees Steam's sign-in code on
# Ignition, plays the game on the path ICE picks, reloads, reconnects and ends the
# session; swiff-hostd restarts the PC clean, attests again, reopens the same
# state and offers it again. Each step is reported PASS or FAIL.
#
# Steam (no account, no network here) and gamescope (no GPU) are stood in for
# (vm/sessiontest/); everything else is the shipped image's.
#
#   swiff-os/vm/session-test.sh             build the image, then run the test
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
# by this user, swtpm, OVMF (/usr/share/OVMF), unshare (user and network
# namespaces), mkfs.ext4, coturn's turnserver (TURNSERVER=path, else on PATH)
# and Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or npx playwright install
# chromium-headless-shell). It waits while another VM runs or the PC has under
# 4 GB free. The VM gets 2 GiB of RAM and 2 vCPUs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/$(basename "$0")
image_dir=$(cd "$here/../image" && pwd)
repo=$(cd "$here/../.." && pwd)
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=$build_dir/output
run=$build_dir/session-vm

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
	exec node "$here/session-harness.mjs" --run "$run" --image "$out/swiffos-sessiontest.raw"
fi

build=1
for arg in "$@"; do
	case $arg in
	--no-build) build=0 ;;
	*)
		echo "usage: $0 [--no-build]" >&2
		exit 2
		;;
	esac
done

for tool in qemu-system-x86_64 swtpm mkosi unshare; do
	command -v "$tool" > /dev/null || die "$tool not found"
done
[ -w /dev/kvm ] || die "/dev/kvm is not usable by $(id -un)"
[ -r /usr/share/OVMF/OVMF_CODE_4M.secboot.fd ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
TURNSERVER=${TURNSERVER:-$(command -v turnserver || true)}
[ -x "$TURNSERVER" ] || die "coturn's turnserver not found: install coturn, or set TURNSERVER"
export TURNSERVER

if [ "$build" = 1 ]; then
	if [ ! -e "$image_dir/mkosi.key" ]; then
		echo "== generating a VM-only test Secure Boot key"
		(
			umask 077
			openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
				-subj "/CN=Lanterel OS VM test Secure Boot key/" \
				-keyout "$image_dir/mkosi.key" -out "$image_dir/mkosi.crt"
		)
	fi
	echo "== building the session test image (mkosi --profile=sessiontest)"
	mkdir -p "$out" "$build_dir/cache"
	"$image_dir/stage.sh" "$out"
	sudo mkosi -C "$image_dir" --output-dir "$out" --cache-dir "$build_dir/cache" --profile=sessiontest -f build
fi
[ -e "$out/swiffos-sessiontest.raw" ] || die "$out/swiffos-sessiontest.raw not built"

echo "== building the server and the web app"
(cd "$repo" && npm run build) > /dev/null

# One VM at a time on this PC, and only with memory to spare.
tries=0
while pgrep -x 'qemu-system-.*' > /dev/null 2>&1 ||
	[ "$(free -m | awk '/^Mem:/ { print $7 }')" -lt 4096 ]; do
	tries=$((tries + 1))
	[ "$tries" -le 20 ] || die "no room for a VM after 60 minutes (another VM, or under 4 GB free)"
	echo "== another VM is running or memory is short; checking again in 3 minutes"
	sleep 180
done

mkdir -p "$run"
exec 9> "$build_dir/session-vm.lock"
flock -n 9 || die "another session-test.sh is running"
echo "== running the test in a network namespace of its own; the run's files are in $run"
exec env SWIFF_SESSION_INSIDE=1 unshare --user --map-root-user --net "$script" "$@"
