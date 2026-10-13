#!/usr/bin/env bash
# Lanterel OS Wi-Fi test: a PC without a cable gets online over the Wi-Fi
# network its owner's app handed over, and a PC that cannot get online reaches
# a defined failure instead of hanging its boot.
#
# Builds the image's Wi-Fi test variant (mkosi --profile=wifitest: the shipped
# image plus vm/wifitest/, the Wi-Fi around the PC) and boots it in QEMU/KVM
# under OVMF with Secure Boot and a software TPM, with no network card:
#
#   boot 1  provisioned as the owner's app provisions a PC on Wi-Fi: a record
#           with a WPA2 network at the start of the keep partition, its access
#           point in reach (mac80211_hwsim, hostapd). Lanterel OS joins it, gets
#           an address and a name resolved through it, keeps the network root's
#           alone and iwd out of the renter's reach.
#   boot 2  the same PC, the access point gone: the verdict is a failure,
#           network-online.target is reached within its minute and no network
#           unit failed.
#   boot 3  provisioned again without Wi-Fi, and no Wi-Fi adapter: a failure
#           too, and the earlier Wi-Fi network is gone.
#
# Each boot's results are the in-image test's lines on the serial console
# (vm/wifitest/usr/libexec/swiff/wifitest). This script adds what needs the
# host's view: no console showed a failed network unit or the passphrase, and
# the keep partition holds the passphrase only sealed.
#
# Usage: vm/wifi-test.sh [--no-build|--rebuild]
#
# The image is built by vm/build-image.sh only when what goes into it changed;
# --rebuild builds it anyway, and --no-build takes the newest stored build.
# Build output, caches and the VM's files go to $SWIFF_OS_BUILD_DIR (default
# ~/.cache/swiff-os), the run in wifi-vm/.
#
# Needs: sudo (mkosi 20 builds as root), qemu-system-x86_64, qemu-img and
# qemu-io, swtpm, OVMF (/usr/share/OVMF), /dev/kvm, mkfs.ext4. The VM gets
# 2 GiB of RAM and 4 vCPUs ($SWIFF_VM_CPUS), and starts through vm/vm-run.py:
# it waits for room among this PC's test VMs, and a boot is stopped when it
# outlasts $BOOT_TIMEOUT (600 s) or its console is silent for $BOOT_STALL
# seconds (300). Nothing here touches the host's disks, boot entries or UEFI
# variables.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
run=$build_dir/wifi-vm

ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.fd
boot_timeout=${BOOT_TIMEOUT:-600}
boot_stall=${BOOT_STALL:-300}
cpus=${SWIFF_VM_CPUS:-4}

# The owner's Wi-Fi network: an SSID iwd names hex-encoded, and a passphrase
# with what iwd's network file must escape (a leading space, a backslash).
ssid='Café Wi-Fi'
passphrase=' \back slash'

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

# Prints a section heading.
log() { printf '\n== %s\n' "$*"; }
# Prints an error and exits.
die() {
	echo "wifi-test: $*" >&2
	exit 1
}

for tool in qemu-system-x86_64 qemu-img qemu-io swtpm mkosi sfdisk mkfs.ext4; do
	command -v "$tool" > /dev/null || [ -x "/usr/sbin/$tool" ] || die "$tool not found"
done
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
qemu=(qemu-system-x86_64)
if [ ! -w /dev/kvm ]; then
	[ -e /dev/kvm ] && sudo -n true 2> /dev/null || die "/dev/kvm is not usable"
	qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")
fi

mkdir -p "$run"
exec 9> "$run/lock"
flock -n 9 || die "another wifi-test.sh is running"

# --- Build -------------------------------------------------------------------
if [ "$build" = 0 ]; then
	disk_src=$(ls -t "$build_dir"/images/wifitest-*.raw 2> /dev/null | head -n1)
else
	log "The Wi-Fi test image (vm/build-image.sh wifitest)"
	rebuild=()
	[ "$build" = 2 ] && rebuild=(--rebuild)
	disk_src=$("$here/build-image.sh" wifitest "${rebuild[@]}").raw
fi
[ -e "$disk_src" ] || die "no Wi-Fi test image built (run without --no-build)"

# --- Prepare the VM ----------------------------------------------------------
log "Preparing the VM in $run"
rm -rf "$run/tpm" "$run/fixtures" "$run"/*.log "$run"/*.qcow2 "$run"/*.fd "$run"/*.img "$run"/*.raw
qemu-img create -q -f qcow2 -b "$disk_src" -F raw "$run/disk.qcow2"
cp "$ovmf_vars" "$run/vars.fd"
mkdir -p "$run/tpm"

read -r keep_start keep_sectors < <(sfdisk -J "$disk_src" |
	python3 -c 'import json,sys
for p in json.load(sys.stdin)["partitiontable"]["partitions"]:
    if p.get("name") == "swiff-keep": print(p["start"], p["size"])')
[ -n "${keep_start:-}" ] || die "no swiff-keep partition in the image"

# Writes a provisioning record at the start of the keep partition, as the
# owner's app does before the restart into Lanterel OS (desktop/provision.cjs):
# with the Wi-Fi network for "wifi", without for "cable".
provision() { # wifi|cable
	SSID=$ssid PASSPHRASE=$passphrase python3 - "$1" "$run/provision.rec" << 'PY'
import hashlib, json, os, struct, sys
payload = {"serverUrl": "ws://127.0.0.1:8080", "machineId": "wifitest-pc", "machineKey": "wifitest-machine-key-0123456789"}
if sys.argv[1] == "wifi":
    payload["wifi"] = {"ssid": os.environ["SSID"], "security": "psk", "passphrase": os.environ["PASSPHRASE"]}
data = json.dumps(payload).encode()
record = b"SWIFFPRV" + struct.pack(">II", 1, len(data)) + hashlib.sha256(data).digest() + data
open(sys.argv[2], "wb").write(record.ljust(4096, b"\0"))
PY
	qemu-io -f qcow2 "$run/disk.qcow2" -c "write -s $run/provision.rec $((keep_start * 512)) 4096" > /dev/null
	rm -f "$run/provision.rec"
}

# Writes the fixture disk the in-image test reads its phase and the network from.
fixtures() { # wifi|no-ap|none
	rm -rf "$run/fixtures" "$run/fixtures.img"
	mkdir "$run/fixtures"
	echo "$1" > "$run/fixtures/phase"
	printf '%s' "$ssid" | od -An -tx1 | tr -d ' \n' > "$run/fixtures/ssid-hex"
	printf '%s' "$passphrase" > "$run/fixtures/passphrase"
	echo "=$(cat "$run/fixtures/ssid-hex").psk" > "$run/fixtures/iwd-name"
	mkfs.ext4 -q -L SWIFFWIFI -d "$run/fixtures" "$run/fixtures.img" 16M
}

# Boots the VM once with swtpm and waits for the in-image test to finish; dies if it does not.
boot_vm() { # boot number
	local n=$1 serial=$run/serial-$1.log rc=0
	log "Boot $n ($(cat "$run/fixtures/phase"))"
	swtpm socket --tpm2 --terminate \
		--tpmstate dir="$run/tpm" \
		--ctrl type=unixio,path="$run/tpm/sock" \
		--log file="$run/swtpm-$n.log" &
	local swtpm_pid=$!
	for _ in $(seq 50); do [ -S "$run/tpm/sock" ] && break; sleep 0.1; done
	"$here/vm-run.py" --name "wifitest-boot$n" --timeout "$boot_timeout" \
		--stall "$boot_stall" --progress "$serial" -- "${qemu[@]}" \
		-machine q35,smm=on,accel=kvm,kernel-irqchip=split \
		-cpu host -smp "$cpus" -m 2048 \
		-global driver=cfi.pflash01,property=secure,value=on \
		-global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$run/vars.fd" \
		-device intel-iommu,intremap=on \
		-chardev socket,id=chrtpm,path="$run/tpm/sock" \
		-tpmdev emulator,id=tpm0,chardev=chrtpm \
		-device tpm-crb,tpmdev=tpm0 \
		-drive if=none,id=os,format=qcow2,cache=unsafe,file="$run/disk.qcow2" \
		-device virtio-blk-pci,drive=os,bootindex=1 \
		-drive if=none,id=fixtures,format=raw,readonly=on,file="$run/fixtures.img" \
		-device virtio-blk-pci,drive=fixtures \
		-nic none -display none -vga none -monitor none \
		-serial "file:$serial" || rc=$?
	kill "$swtpm_pid" 2> /dev/null || true
	wait "$swtpm_pid" 2> /dev/null || true
	grep -q 'SWIFF-WIFITEST DONE' "$serial" || {
		tail -n 40 "$serial" >&2
		die "boot $n did not finish the Wi-Fi test (serial log: $serial)"
	}
	[ "$rc" = 0 ] || die "boot $n: the VM did not power off cleanly (vm-run.py status $rc; serial log: $serial)"
}

# Whether the keep partition, as the VM left it, holds the passphrase in the clear anywhere.
keep_clear() {
	rm -f "$run/keep.raw"
	qemu-img convert -O raw "json:{\"driver\":\"raw\",\"offset\":$((keep_start * 512)),\"size\":$((keep_sectors * 512)),\"file\":{\"driver\":\"qcow2\",\"file\":{\"driver\":\"file\",\"filename\":\"$run/disk.qcow2\"}}}" "$run/keep.raw"
	if grep -aqF -- "$passphrase" "$run/keep.raw"; then echo found; else echo absent; fi
	rm -f "$run/keep.raw"
}

provision wifi
fixtures wifi
boot_vm 1
keep_after_wifi=$(keep_clear)

fixtures no-ap
boot_vm 2

provision cable
fixtures none
boot_vm 3

# --- Verdict -------------------------------------------------------------------
log "Results"
fail=0
# Prints one row of the results table and records a failure.
result() { # PASS|FAIL name detail
	printf '%-4s  %-30s %s\n' "$1" "$2" "$3"
	[ "$1" = PASS ] || fail=1
}

for n in 1 2 3; do
	while read -r status name detail; do
		result "$status" "boot$n/$name" "$detail"
	done < <(sed -n 's/^.*SWIFF-WIFITEST \(PASS\|FAIL\) /\1 /p' "$run/serial-$n.log" | tr -d '\r')
	failed=$(grep -aE 'FAILED.*([Nn]etwork|iwd|wait-online)' "$run/serial-$n.log" | tr -d '\r' | head -n1 || true)
	if [ -z "$failed" ]; then
		result PASS "boot$n/console-no-failed-network" "no failed network unit on the console"
	else
		result FAIL "boot$n/console-no-failed-network" "$failed"
	fi
done
if grep -aqF -- "$passphrase" "$run"/serial-*.log; then
	result FAIL console-no-passphrase "the passphrase is on a serial console"
else
	result PASS console-no-passphrase "the passphrase is on no serial console"
fi
if [ "$keep_after_wifi" = absent ]; then
	result PASS keep-sealed "the keep holds the passphrase only sealed"
else
	result FAIL keep-sealed "the passphrase is in the clear on the keep"
fi

echo
if [ "$fail" = 0 ]; then
	echo "Lanterel OS Wi-Fi test: PASS"
else
	echo "Lanterel OS Wi-Fi test: FAIL (serial logs in $run)"
	exit 1
fi
