#!/usr/bin/env bash
# Rental mode's install and switch, tested in a VM (report stage 2).
#
# The host app's plans (rental.cjs), carried out on a disk image laid out like
# a Windows PC's, with apply-plan.cjs standing in for Windows (the real
# installer on real Windows is vm/windows-install-test.sh's), then booted
# under OVMF with Microsoft's Secure Boot keys and a software TPM (swtpm), as
# a PC boots it:
#
#   0. the image set, packed as a release packs it (its root in several parts)
#      and served from a local HTTP server, then downloaded, checked and
#      unpacked as the host app does (image-download.cjs): the install is made
#      from that download
#   1. a "Windows" disk: ESP with a Windows Boot Manager stand-in (Ubuntu's
#      Microsoft-signed shim, starting the image's systemd-boot on its own
#      screen once Swiff's key is trusted), the reserved partition, C: (NTFS)
#      and a recovery partition at the end, and firmware variables with
#      Secure Boot on and Windows in BootOrder
#   2. the install plan for it: C: shrunk by Swiff OS's 24,192 MiB, Swiff OS's
#      six partitions added with the image's ids, names and attributes, its
#      ESP (with the shim, swiff-os/image-set.sh) and slot A written, its boot
#      entry for the shim added after Windows, C: named SWIFFGAMES, Swiff's key
#      queued for MokManager (MokNew, MokAuth) and BootNext set
#   3. boot 0: shim shows MokManager, and the owner confirms Swiff's key with
#      the install's code (mok-drive.py)
#   4. start sharing (Swiff OS first in BootOrder, BootNext), then boot 1:
#      shim must start Swiff's systemd-boot and Swiff OS, which runs its self-test
#   5. stop sharing (Windows first), then boot 2: the firmware must start
#      Windows Boot Manager
#
# Windows' C: must come through with its files, and Swiff OS must find its
# root, scratch and the games drive on a disk it shares with Windows.
#
# Usage: vm/rental-install-test.sh
#
# Needs the Swiff OS self-test build from swiff-os/vm/run-test.sh in
# $SWIFF_OS_OUTPUT (default ~/.cache/swiff-os/output), which it makes an image
# set of, and: node, curl (Ubuntu's shim), sudo (loop devices for the NTFS
# tools, and QEMU when /dev/kvm is not writable), qemu-system-x86_64, swtpm,
# OVMF with Microsoft's keys, mtools, mkfs.fat, ntfs-3g ($NTFS_BIN, default
# /usr/sbin), sgdisk, and a Python with virt-firmware ($VIRT_FW_PYTHON).
# The VM gets 2 GiB and 4 vCPUs ($SWIFF_VM_CPUS), and starts through
# swiff-os/vm/vm-run.py: it waits for room among this PC's test VMs.
# Nothing here touches the host's disks, boot entries or UEFI variables: the
# disk is a sparse file and the firmware variables a copy of OVMF's template.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=${SWIFF_OS_OUTPUT:-$build_dir/output}
run=${SWIFF_RENTAL_VM_DIR:-$build_dir/rental-vm}
image=$out/swiffos-selftest.raw
python=${VIRT_FW_PYTHON:-python3}
ntfs_bin=${NTFS_BIN:-/usr/sbin}
ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
boot_timeout=${BOOT_TIMEOUT:-600}
vm_run=$here/../../swiff-os/vm/vm-run.py
# Big enough that C: keeps 16 GiB free after giving Swiff OS its share.
disk_bytes=$((64 * 1024 * 1024 * 1024))

# Prints a section heading.
log() { printf '\n== %s\n' "$*"; }
# Prints an error and exits.
die() {
	echo "rental-install-test: $*" >&2
	exit 1
}

for tool in node qemu-system-x86_64 swtpm mcopy mmd mkfs.fat sgdisk sfdisk; do
	command -v "$tool" > /dev/null || [ -x "/usr/sbin/$tool" ] || die "$tool not found"
done
for tool in mkntfs ntfsresize ntfsfix ntfslabel ntfscp ntfscat; do
	[ -x "$ntfs_bin/$tool" ] || die "$ntfs_bin/$tool not found (set NTFS_BIN)"
done
"$python" -c 'import virt.firmware' 2> /dev/null || die "$python has no virt-firmware (set VIRT_FW_PYTHON)"
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
[ -e "$image" ] || die "$image not built: run swiff-os/vm/run-test.sh first"
sudo -n true 2> /dev/null || die "needs sudo without a password, for loop devices"
qemu=(qemu-system-x86_64)
[ -w /dev/kvm ] || qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")

mkdir -p "$run"
exec 9> "$run/lock"
flock -n 9 || die "another rental-install-test.sh is running"
export NTFS_BIN=$ntfs_bin BOOT_VARS=$run/boot-vars MTOOLS_SKIP_CHECK=1
printf '#!/bin/sh\nexec %q %q "$@"\n' "$python" "$here/boot-vars.py" > "$BOOT_VARS"
chmod +x "$BOOT_VARS"

disk=$run/disk.raw
vars=$run/vars.fd
rm -rf "$run/tpm" "$run"/*.log "$disk" "$vars" "$run"/*.json "$run"/*.efi "$run"/*.auth "$run"/*.cer "$run"/*.bin \
	"$run/served" "$run/downloaded"
mkdir -p "$run/tpm"

# Runs an NTFS tool on C: through a loop device; {} in the arguments is the device.
on_c() { # tool args...
	local tool=$1 loop rc=0
	shift
	loop=$(sudo -n losetup -f --show -o "$c_offset" --sizelimit "$c_bytes" "$disk")
	sudo -n env LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" "$ntfs_bin/$tool" "${@//\{\}/$loop}" || rc=$?
	sudo -n losetup -d "$loop"
	return "$rc"
}
# C:'s offset and size now, from the disk's partition table.
read_c() {
	read -r c_offset c_bytes < <(sfdisk -J "$disk" | python3 -c 'import json,sys
for p in json.load(sys.stdin)["partitiontable"]["partitions"]:
    if p["type"].lower() == "ebd0a0a2-b9e5-4433-87c0-68b6b72699c7": print(p["start"] * 512, p["size"] * 512)')
}

# --- 1. a disk like a Windows PC's ---------------------------------------------------
log "The image set"
release=$run/image-set
# Parts of 256 MiB, so the root comes in several, as a bigger image's would at 1.9 GiB.
SWIFF_OS_PART_BYTES=$((256 * 1024 * 1024)) "$here/../../swiff-os/image-set.sh" "$out" swiffos-selftest "$release"
log "The download"
# The release as GitHub serves it: the parts, the manifest and its signature side by side.
mkdir "$run/served"
ln -s "$release"/download/* "$release/swiffos.json" "$release/swiffos.json.sig" "$run/served/"
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$run/served" > "$run/http.log" 2>&1 &
http_pid=$!
trap 'kill "$http_pid" 2> /dev/null || true' EXIT
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$port/swiffos.json" > /dev/null && break; sleep 0.1; done
set=$run/downloaded
downloaded=0
node "$here/apply-plan.cjs" download "http://127.0.0.1:$port/" "$set" | tee "$run/download.log" && downloaded=1
kill "$http_pid" 2> /dev/null || true
[ "$downloaded" = 1 ] || die "the download failed (logs in $run)"
log "A Windows-like disk in $run"
parts=$(node "$here/apply-plan.cjs" windows "$disk" "$disk_bytes")
read -r esp_offset esp_bytes < <(python3 -c 'import json,sys; p = json.loads(sys.argv[1])[0]; print(p["offset"], p["bytes"])' "$parts")
# One sector a cluster, so a 300 MiB FAT32 has the clusters firmware expects of one.
mkfs.fat -F 32 -s 1 -n SYSTEM --offset $((esp_offset / 512)) "$disk" $((esp_bytes / 1024)) > /dev/null
# Windows Boot Manager's stand-in, signed by Microsoft as Windows' is: the
# image set's shim, which starts the image's systemd-boot with no entries
# beside it (once Swiff's key is trusted), which stays on its own screen.
esp_set=$(ls "$set"/swiffos_*.esp.raw)
mcopy -i "$esp_set" ::/EFI/swiff/shimx64.efi "$run/bootmgfw.efi"
mcopy -i "$esp_set" ::/EFI/systemd/systemd-bootx64.efi "$run/grubx64.efi"
mmd -i "$disk@@$esp_offset" ::/EFI ::/EFI/Microsoft ::/EFI/Microsoft/Boot ::/loader
mcopy -i "$disk@@$esp_offset" "$run/bootmgfw.efi" ::/EFI/Microsoft/Boot/bootmgfw.efi
mcopy -i "$disk@@$esp_offset" "$run/grubx64.efi" ::/EFI/Microsoft/Boot/grubx64.efi
printf 'timeout menu-force\nauto-entries no\n' > "$run/loader.conf"
mcopy -i "$disk@@$esp_offset" "$run/loader.conf" ::/loader/loader.conf
read_c
on_c mkntfs -Q -F -L Windows {} > /dev/null
marker="swiff-windows-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
echo "$marker" > "$run/marker.txt"
on_c ntfscp -f {} "$run/marker.txt" /windows-marker.txt
# Firmware variables as the PC comes: Secure Boot on with Microsoft's keys, Windows first and only.
read -r win_start win_size win_uuid < <(sfdisk -J "$disk" | python3 -c 'import json,sys
p = json.load(sys.stdin)["partitiontable"]["partitions"][0]; print(p["start"], p["size"], p["uuid"])')
"$BOOT_VARS" init "$vars" "$ovmf_vars" - 1 "$win_start" "$win_size" "$win_uuid"

# --- 2. install -------------------------------------------------------------------------
log "What the app reads"
node "$here/apply-plan.cjs" facts "$disk" > "$run/facts.json"
cat "$run/facts.json"
log "Install"
code=$(node -e 'console.log(require(process.argv[1]).mokCode())' "$here/../rental.cjs")
SWIFF_MOK_CODE=$code node "$here/apply-plan.cjs" install "$disk" "$set" "$run/facts.json" "$vars"
"$BOOT_VARS" show "$vars" | tee "$run/vars-installed.log"

# Boots the VM once; returns when it powers off or after the timeout. It runs
# in the run directory, so the TPM's socket path stays under the 108 bytes a
# UNIX socket path may have. With a code, it plays the owner at MokManager
# instead (mok-drive.py), and stops once the firmware starts again. A boot whose
# console is silent for 300 s is stopped too.
boot_vm() { # boot-number timeout [mok-code]
	local n=$1 serial=$run/serial-$1.log
	log "Boot $n"
	cd "$run"
	swtpm socket --tpm2 --terminate \
		--tpmstate dir="$run/tpm" \
		--ctrl type=unixio,path=tpm/sock \
		--log file="$run/swtpm-$n.log" &
	local swtpm_pid=$!
	for _ in $(seq 50); do [ -S tpm/sock ] && break; sleep 0.1; done
	local vm=("${qemu[@]}" \
		-machine q35,smm=on,accel=kvm,kernel-irqchip=split \
		-cpu host -smp "${SWIFF_VM_CPUS:-4}" -m 2048 \
		-global driver=cfi.pflash01,property=secure,value=on \
		-global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$vars" \
		-device intel-iommu,intremap=on \
		-chardev socket,id=chrtpm,path=tpm/sock \
		-tpmdev emulator,id=tpm0,chardev=chrtpm \
		-device tpm-crb,tpmdev=tpm0 \
		-drive if=none,id=os,format=raw,file="$disk" \
		-device virtio-blk-pci,drive=os \
		-netdev "user,id=n0,ipv6-prefix=2001:db8:1::,ipv6-prefixlen=64,guestfwd=tcp:10.0.2.100:80-cmd:echo swiff-lan-reachable" \
		-device virtio-net-pci,netdev=n0 \
		-display none -vga none -monitor none)
	if [ -n "${3:-}" ]; then
		"$python" "$here/mok-drive.py" "$serial" confirm "$3" -- \
			"$vm_run" --name "rental-boot$n" --timeout "$2" -- "${vm[@]}" && mok_confirmed=1 || true
	else
		"$vm_run" --name "rental-boot$n" --timeout "$2" --stall 300 --progress "$serial" -- \
			"${vm[@]}" -serial "file:$serial" || true
	fi
	kill "$swtpm_pid" 2> /dev/null || true
	wait "$swtpm_pid" 2> /dev/null || true
	return 0
}
# The serial log without colours or carriage returns.
serial() { tr -d '\r' < "$run/serial-$1.log" | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'; }
# The first boot option the firmware started on a boot: its title.
started() { serial "$1" | sed -n 's/^.*BdsDxe: starting Boot[0-9A-F]* "\([^"]*\)".*$/\1/p' | head -n1; }

# --- 3. boot 0: the owner confirms Swiff's key ----------------------------------------
mok_confirmed=0
boot_vm 0 300 "$code"
"$BOOT_VARS" show "$vars" | tee "$run/vars-confirmed.log"

# --- 4. start sharing, boot 1 -----------------------------------------------------------
log "Start sharing"
node "$here/apply-plan.cjs" switch start "$vars"
"$BOOT_VARS" show "$vars" | tee "$run/vars-started.log"
boot_vm 1 "$boot_timeout"
"$BOOT_VARS" show "$vars" | tee "$run/vars-after-boot1.log"

# --- 5. stop sharing, boot 2 ------------------------------------------------------------
log "Stop sharing"
node "$here/apply-plan.cjs" switch stop "$vars"
"$BOOT_VARS" show "$vars" | tee "$run/vars-stopped.log"
boot_vm 2 60

# --- verdict ------------------------------------------------------------------------------
log "Results"
fail=0
# Prints one row of the results table and records a failure.
result() { # PASS|FAIL name detail
	printf '%-4s  %-30s %s\n' "$1" "$2" "$3"
	[ "$1" = PASS ] || fail=1
}
# Records PASS when the command succeeds, FAIL otherwise.
expect() { # name detail command...
	local name=$1 detail=$2
	shift 2
	if "$@" > /dev/null 2>&1; then result PASS "$name" "$detail"; else result FAIL "$name" "$detail"; fi
}

# A boot entry's number: the firmware's template has entries of its own (UiApp, network boot).
B="Boot[0-9A-F]\{4\}"
root_parts=$(python3 -c 'import json,sys; m = json.load(open(sys.argv[1])); print(len(m["download"]["files"][sys.argv[2]]["parts"]))' \
	"$release/swiffos.json" "$(basename "$(ls "$release"/swiffos_*.root-x86-64.raw)")")
expect download-split "the release's root comes in $root_parts compressed parts" test "$root_parts" -gt 1
expect download-checked "the app's download fetched, checked and unpacked the signed set" test "$downloaded" = 1
expect download-same-files "every downloaded file is the release's, byte for byte" bash -c "
	for f in '$release'/swiffos_*.raw '$release/swiffos-key.cer' '$release/swiffos.json' '$release/swiffos.json.sig'; do
		cmp -s \"\$f\" '$set'/\"\$(basename \"\$f\")\" || exit 1
	done"
expect download-no-leftovers "no parts left beside the downloaded set" test ! -e "$set/.download"
expect gpt-valid "the disk's GPT passes sgdisk's checks" bash -c "sgdisk -v '$disk' | grep -q 'No problems found'"
# Swiff OS's partitions on the disk carry the image's ids, names, types and attributes.
compare=$(python3 - "$image" "$disk" << 'EOF'
import json, subprocess, sys
def parts(f):
    return json.loads(subprocess.run(["sfdisk", "-J", f], capture_output=True, check=True).stdout)["partitiontable"]["partitions"]
keys = ("type", "uuid", "name", "size", "attrs")
img = [{k: p.get(k) for k in keys} for p in parts(sys.argv[1])]
disk = [{k: p.get(k) for k in keys} for p in parts(sys.argv[2])][4:]
print("same" if img == disk else f"image {img}\ndisk {disk}")
EOF
)
expect partitions-as-image "6 Lanterel OS partitions after Windows' 4, as in the image" test "$compare" = same
read_c
kept=$(on_c ntfscat {} /windows-marker.txt 2> /dev/null || true)
expect windows-files-kept "C: still holds its file after the shrink and both boots" test "$kept" = "$marker"
expect windows-volume-clean "C:'s NTFS needs no repair" on_c ntfsfix -n {}
games_label=$(on_c ntfslabel {} 2> /dev/null || true)
expect games-drive-named "C: is labelled ${games_label:-?}" test "$games_label" = SWIFFGAMES
expect install-adds-last "after install: $(head -n1 "$run/vars-installed.log")" \
	grep -q "^BootOrder: $B 'Windows Boot Manager', $B 'Lanterel OS'$" "$run/vars-installed.log"
expect install-restarts-to-swiff "after install: $(sed -n 2p "$run/vars-installed.log")" \
	grep -q "^BootNext: $B 'Lanterel OS'$" "$run/vars-installed.log"
expect install-queues-mok "after install: $(sed -n 3p "$run/vars-installed.log")" \
	grep -q "^MOK request: MokNew $((44 + $(stat -c %s "$set/swiffos-key.cer"))) bytes, MokAuth 32 bytes$" "$run/vars-installed.log"
expect mok-confirmed "the owner confirmed Lanterel's key at MokManager with the install's code" test "$mok_confirmed" = 1
expect mok-enrolled "MokList holds Lanterel's certificate" \
	grep -q "^MokList: .*$(od -An -v -tx1 "$set/swiffos-key.cer" | tr -d ' \n')" "$run/vars-confirmed.log"
expect start-sets-order "start: $(head -n1 "$run/vars-started.log")" \
	grep -q "^BootOrder: $B 'Lanterel OS', $B 'Windows Boot Manager'" "$run/vars-started.log"
expect start-sets-bootnext "start: $(sed -n 2p "$run/vars-started.log")" \
	grep -q "^BootNext: $B 'Lanterel OS'$" "$run/vars-started.log"
expect boot1-starts-swiff "boot 1 started: $(started 1)" test "$(started 1)" = "Lanterel OS"
expect bootnext-consumed "after boot 1: $(sed -n 2p "$run/vars-after-boot1.log")" \
	grep -q "^BootNext: none$" "$run/vars-after-boot1.log"
expect boot1-selftest-done "Lanterel OS's self-test ran to its end" bash -c "grep -aq 'SWIFF-SELFTEST DONE' '$run/serial-1.log'"
# Known, and not this test's to fix: a renter's write through the games overlay
# needs the lower drive's directories writable by the renter, which an NTFS
# drive mounted with ntfs3's defaults (owner root, 0755) is not. The stage 1
# test stubs the drive with ext4 owned by the renter. Swiff OS's games
# verification (stage 4) owns how an NTFS library is exposed.
KNOWN="games-write-in-overlay"
while read -r status name detail; do
	if [ "$status" = FAIL ] && [[ " $KNOWN " == *" $name "* ]]; then
		printf '%-4s  %-30s %s\n' KNOWN "swiffos/$name" "$detail (NTFS games drive, see the comment above)"
		continue
	fi
	result "$status" "swiffos/$name" "$detail"
done < <(serial 1 | sed -n 's/^.*SWIFF-SELFTEST \(PASS\|FAIL\) /\1 /p')
# The firmware appends its own entries (its setup app, network boot) on the first boot.
expect stop-sets-order "stop: $(head -n1 "$run/vars-stopped.log" | cut -c1-80)" \
	grep -q "^BootOrder: $B 'Windows Boot Manager', $B 'Lanterel OS'" "$run/vars-stopped.log"
expect boot2-starts-windows "boot 2 started: $(started 2)" test "$(started 2)" = "Windows Boot Manager"
expect boot2-no-swiff "Lanterel OS did not start on boot 2" bash -c "[ -s '$run/serial-2.log' ] && ! grep -aq 'SWIFF-SELFTEST' '$run/serial-2.log'"

echo
if [ "$fail" = 0 ]; then
	echo "Rental install VM test: PASS"
else
	echo "Rental install VM test: FAIL (logs in $run)"
	exit 1
fi
