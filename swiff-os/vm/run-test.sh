#!/usr/bin/env bash
# Swiff OS Stage 1 VM test.
#
# Builds the image's test variant (mkosi --profile=selftest), then boots it
# twice in QEMU/KVM under OVMF with Secure Boot and a software TPM (swtpm):
#
#   boot 1  the firmware starts in setup mode; systemd-boot enrols the test
#           Secure Boot certificate (PK, KEK, db) and resets, and the signed
#           UKI then boots with Secure Boot enforcing. The in-image self-test
#           runs and powers off.
#   boot 2  a cold boot of the same disk, firmware variables and TPM state:
#           everything written during boot 1 must be gone.
#
# The self-test reports on the serial console; this script collects the
# results and adds the checks that need the host's view: the scratch
# partition holds no plaintext, it changes completely across a reboot, and
# PCR 11 equals the value systemd-measure predicts for the built UKI. It
# also presses the keys the self-test asks for (Ctrl+Alt+Del, VT switches) on
# the VM's keyboard, through QEMU's monitor, and checks that none of them
# rebooted the VM.
#
# Usage: vm/run-test.sh [--no-build]
#
# Build output, caches and the VM's files go to $SWIFF_OS_BUILD_DIR
# (default ~/.cache/swiff-os).
#
# Needs: sudo (mkosi 20 builds as root), qemu-system-x86_64, swtpm, OVMF
# (/usr/share/OVMF), /dev/kvm, bwrap. The VM gets 2 GiB of RAM and 2 vCPUs.
# Nothing here touches the host's disks, boot entries or UEFI variables: the
# VM's firmware variables are a copy of OVMF's empty template in the run directory.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image_dir=$(cd "$here/../image" && pwd)
# Build output and caches stay outside the source tree (see image/mkosi.conf).
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=$build_dir/output
# The VM's disk copy (24 GiB, sparse), firmware variables, TPM state and logs.
run=$build_dir/vm

ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
# The template without Microsoft keys: the firmware starts in setup mode and
# trusts only what systemd-boot enrols from the image.
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.fd
boot_timeout=${BOOT_TIMEOUT:-600}

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

# Prints a section heading.
log() { printf '\n== %s\n' "$*"; }
# Prints an error and exits.
die() {
	echo "run-test: $*" >&2
	exit 1
}

for tool in qemu-system-x86_64 swtpm mkosi bwrap sfdisk mkfs.ext4 debugfs; do
	command -v "$tool" > /dev/null || [ -x "/usr/sbin/$tool" ] || die "$tool not found"
done
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
# QEMU normally runs as the calling user. Without access to /dev/kvm it is
# started through sudo and drops to the calling user (-runas) before the VM
# starts, rather than changing the host's device permissions.
qemu=(qemu-system-x86_64)
if [ ! -w /dev/kvm ]; then
	[ -e /dev/kvm ] && sudo -n true 2> /dev/null || die "/dev/kvm is not usable"
	qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")
fi

mkdir -p "$run"
# One VM at a time.
exec 9> "$run/lock"
flock -n 9 || die "another run-test.sh is running"

# --- Build -------------------------------------------------------------------
if [ ! -e "$image_dir/mkosi.key" ]; then
	log "Generating a VM-only test Secure Boot key"
	# The private key is unencrypted (mkosi signs non-interactively), so it
	# is created readable by its owner only.
	(
		umask 077
		openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
			-subj "/CN=Swiff OS VM test Secure Boot key/" \
			-keyout "$image_dir/mkosi.key" -out "$image_dir/mkosi.crt"
	)
fi
if [ "$build" = 1 ]; then
	log "Building the test image (mkosi --profile=selftest)"
	mkdir -p "$out" "$build_dir/cache"
	sudo mkosi -C "$image_dir" --output-dir "$out" --cache-dir "$build_dir/cache" --profile=selftest -f build
fi
disk_src=$out/swiffos-selftest.raw
uki=$out/swiffos-selftest.efi
[ -e "$disk_src" ] || die "$disk_src not built"

# --- Prepare the VM ----------------------------------------------------------
log "Preparing the VM in $run"
rm -rf "$run/tpm" "$run"/*.log "$run"/*.raw "$run"/*.fd "$run"/*.img "$run/games"
cp --sparse=always "$disk_src" "$run/disk.raw"
cp "$ovmf_vars" "$run/vars.fd"
mkdir -p "$run/tpm"

# The shared games library, stubbed: a small read-only ext4 disk labelled
# SWIFFGAMES with a Steam library the renter (uid 1000) may update.
mkdir -p "$run/games/steamapps/common/StubGame"
echo '"AppState" { "appid" "0" "name" "Stub game" "StateFlags" "4" }' > "$run/games/steamapps/appmanifest_0.acf"
echo stub > "$run/games/steamapps/common/StubGame/game.bin"
mkfs.ext4 -q -L SWIFFGAMES -E root_owner=0:0 -d "$run/games" "$run/games.img" 64M
debugfs -w -R "set_inode_field /steamapps uid 1000" "$run/games.img" > /dev/null 2>&1

# Where the scratch partition sits in the disk image, for the host-side checks.
read -r scratch_start scratch_sectors < <(sfdisk -J "$run/disk.raw" |
	python3 -c 'import json,sys
for p in json.load(sys.stdin)["partitiontable"]["partitions"]:
    if p.get("name") == "swiff-scratch": print(p["start"], p["size"])')
[ -n "${scratch_start:-}" ] || die "no swiff-scratch partition in the image"

# Presses one round of keys on the VM's keyboard through QEMU's monitor
# (fd 8). Every round ends with Ctrl+Alt+Del, which the self-test waits for.
press_keys() { # round
	local keys key
	case $1 in
	# 10 Ctrl+Alt+Del within 2 s: more than systemd's burst limit of 7.
	locked) keys="ctrl-alt-f2 alt-f2 alt-right alt-left alt-up $(printf 'ctrl-alt-delete %.0s' $(seq 10))" ;;
	unlocked) keys="ctrl-alt-f2 ctrl-alt-delete" ;;
	*) return ;;
	esac
	# QEMU waits the hold time (ms) after every key-down and key-up, so a
	# Ctrl+Alt+Del chord takes 6 of them: 10 ms puts all 10 within 2 s.
	for key in $keys; do printf 'sendkey %s 10\n' "$key" >&8; done
}

# Watches a boot's serial log for the self-test's "SWIFF-SELFTEST KEYS
# <round>" lines and presses each round's keys once.
drive_keys() { # serial-log
	local serial=$1 seen=0 rounds
	exec 8> "$run/monitor.in"
	while :; do
		mapfile -t rounds < <(sed -n 's/^.*SWIFF-SELFTEST KEYS \([a-z]*\).*$/\1/p' "$serial" 2> /dev/null)
		while [ "$seen" -lt "${#rounds[@]}" ]; do
			press_keys "${rounds[$seen]}"
			seen=$((seen + 1))
		done
		sleep 0.5
	done
}

# Boots the VM once with swtpm and waits for the self-test to finish;
# dies if it does not.
boot_vm() { # boot number
	local n=$1 serial=$run/serial-$1.log
	log "Boot $n"
	swtpm socket --tpm2 --terminate \
		--tpmstate dir="$run/tpm" \
		--ctrl type=unixio,path="$run/tpm/sock" \
		--log file="$run/swtpm-$n.log" &
	local swtpm_pid=$!
	for _ in $(seq 50); do [ -S "$run/tpm/sock" ] && break; sleep 0.1; done
	# QEMU's monitor on a pair of pipes, which the calling user owns even
	# when QEMU is started through sudo.
	rm -f "$run"/monitor.*
	mkfifo -m 600 "$run/monitor.in" "$run/monitor.out"
	cat "$run/monitor.out" > "$run/monitor-$n.log" &
	local monitor_pid=$!
	drive_keys "$serial" &
	local keys_pid=$!

	local rc=0
	timeout "$boot_timeout" "${qemu[@]}" \
		-machine q35,smm=on,accel=kvm,kernel-irqchip=split \
		-cpu host -smp 2 -m 2048 \
		-global driver=cfi.pflash01,property=secure,value=on \
		-global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$run/vars.fd" \
		-device intel-iommu,intremap=on \
		-chardev socket,id=chrtpm,path="$run/tpm/sock" \
		-tpmdev emulator,id=tpm0,chardev=chrtpm \
		-device tpm-crb,tpmdev=tpm0 \
		-drive if=none,id=os,format=raw,file="$run/disk.raw" \
		-device virtio-blk-pci,drive=os,bootindex=1 \
		-drive if=none,id=games,format=raw,readonly=on,file="$run/games.img" \
		-device virtio-blk-pci,drive=games \
		-netdev "user,id=n0,ipv6-prefix=2001:db8:1::,ipv6-prefixlen=64,guestfwd=tcp:10.0.2.100:80-cmd:echo swiff-lan-reachable" \
		-device virtio-net-pci,netdev=n0 \
		-display none -vga none -monitor "pipe:$run/monitor" \
		-serial "file:$serial" || rc=$?
	kill "$swtpm_pid" "$keys_pid" "$monitor_pid" 2> /dev/null || true
	wait "$swtpm_pid" "$keys_pid" "$monitor_pid" 2> /dev/null || true
	[ "$rc" = 124 ] && echo "boot $n timed out after ${boot_timeout}s" >&2
	grep -q 'SWIFF-SELFTEST DONE' "$serial" || {
		tail -n 40 "$serial" >&2
		die "boot $n did not finish the self-test (serial log: $serial)"
	}
}

# Hashes the first 4 MiB of the scratch partition in the disk image.
scratch_digest() {
	dd if="$run/disk.raw" bs=512 skip="$scratch_start" count=8192 status=none | sha256sum | cut -d' ' -f1
}

boot_vm 1
digest1=$(scratch_digest)
token=$(sed -n 's/^.*SWIFF-SELFTEST INFO marker \(.*\)$/\1/p' "$run/serial-1.log" | tr -d '\r' | tail -n1)
plaintext=absent
if [ -n "$token" ] &&
	dd if="$run/disk.raw" bs=1M iflag=skip_bytes,count_bytes skip=$((scratch_start * 512)) \
		count=$((scratch_sectors * 512)) status=none | grep -aqF "$token"; then
	plaintext=found
fi

boot_vm 2
digest2=$(scratch_digest)

# --- Expected PCR 11 -----------------------------------------------------------
# systemd-measure (from the build's tools tree) predicts PCR 11 for this UKI
# after the boot phases enter-initrd, leave-initrd, sysinit and ready.
tools=$out/ubuntu-tools
expected_pcr11=$(bwrap --ro-bind "$tools/usr" /usr \
	--symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
	--ro-bind "$uki" /uki.efi --ro-bind "$here/measure-uki.py" /measure-uki.py \
	--proc /proc --dev /dev --tmpfs /tmp \
	python3 /measure-uki.py /uki.efi 2> "$run/measure.log" || true)

# --- Verdict -------------------------------------------------------------------
log "Results"
fail=0
# Prints one row of the results table and records a failure.
result() { # PASS|FAIL name detail
	printf '%-4s  %-30s %s\n' "$1" "$2" "$3"
	[ "$1" = PASS ] || fail=1
}

for n in 1 2; do
	while read -r status name detail; do
		result "$status" "boot$n/$name" "$detail"
	done < <(sed -n 's/^.*SWIFF-SELFTEST \(PASS\|FAIL\) /\1 /p' "$run/serial-$n.log" | tr -d '\r')
done

pcr11=$(sed -n 's/^.*SWIFF-SELFTEST INFO pcr11 \(.*\)$/\1/p' "$run/serial-2.log" | tr -d '\r' | tr 'A-F' 'a-f')
if [ -n "$expected_pcr11" ] && [ "$pcr11" = "$expected_pcr11" ]; then
	result PASS pcr11-matches-uki "PCR 11 = systemd-measure prediction for the built UKI"
else
	result FAIL pcr11-matches-uki "booted $pcr11, predicted ${expected_pcr11:-none} (see $run/measure.log)"
fi
if [ -n "$token" ] && [ "$plaintext" = absent ]; then
	result PASS scratch-encrypted "renter's marker not in the scratch partition's raw bytes"
else
	result FAIL scratch-encrypted "marker '${token:-missing}' $plaintext in the raw scratch partition"
fi
# Linux started once per boot: no key the self-test asked for rebooted it.
for n in 1 2; do
	starts=$(grep -ac 'SWIFF-SELFTEST INFO boot ' "$run/serial-$n.log")
	if [ "$starts" = 1 ]; then
		result PASS "boot$n/keys-no-reboot" "Linux started once; the keys did not reboot the VM"
	else
		result FAIL "boot$n/keys-no-reboot" "Linux started $starts times during boot $n"
	fi
done
if [ "$digest1" != "$digest2" ]; then
	result PASS scratch-rekeyed "first 4 MiB of scratch differ completely after reboot"
else
	result FAIL scratch-rekeyed "scratch partition unchanged across reboot"
fi
disk_bytes=$(stat -c %s "$run/disk.raw")
if [ "$disk_bytes" -le $((24 * 1024 * 1024 * 1024)) ]; then
	result PASS size-budget "disk image $((disk_bytes / 1024 / 1024)) MiB <= 24 GiB"
else
	result FAIL size-budget "disk image $((disk_bytes / 1024 / 1024)) MiB > 24 GiB"
fi

echo
if [ "$fail" = 0 ]; then
	echo "Swiff OS VM test: PASS"
else
	echo "Swiff OS VM test: FAIL (serial logs in $run)"
	exit 1
fi
