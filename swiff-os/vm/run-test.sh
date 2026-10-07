#!/usr/bin/env bash
# Swiff OS VM test.
#
# Builds the image's test variant (mkosi --profile=selftest), then boots it
# in QEMU/KVM under OVMF with Secure Boot and a software TPM (swtpm):
#
#   boot 1  the firmware starts in setup mode; systemd-boot enrols the test
#           Secure Boot certificate (PK, KEK, db) and resets, and the signed
#           UKI then boots with Secure Boot enforcing. The in-image self-test
#           runs and powers off. The owner's games are validated (bootstrap).
#   boot 2  a cold boot of the same disk, firmware variables and TPM state:
#           everything written during boot 1 must be gone. The renter's
#           game updates are sealed or refused.
#   boot 3  only the update that verified was promoted onto the library.
#   (firmware only, standing in for the owner's Windows, after the library
#           was changed: a DLL planted in one game, a file changed in another
#           with its size and mtime kept)
#   boot 4  a full re-hash blocks both games.
#   boot 5  no other OS booted: both games stay blocked.
#   boot 6  the table key no longer unseals: every game is blocked and the
#           key is kept until the owner bootstraps a game again.
#   boot 7  the table is rewritten with a newer version, as by the other
#           slot's OS, and the owner bootstraps a game: nothing is promoted.
#   boot 8  the newer table was kept. It is replaced with a directory and the
#           owner bootstraps a game: nothing is promoted.
#   boot 9  the unreadable table was kept. It is replaced with corrupt JSON:
#           a renter's seal is refused and the owner's bootstrap replaces it.
#   boot 10 the table key no longer unseals and the TPM cannot seal: the
#           owner bootstraps a game, and at shutdown nothing is promoted and
#           the old key is kept.
#   boot 11 the key and table are removed, and the TPM cannot seal a new key:
#           the games service still starts and every game stays unverified.
#   boot 12 the same disk with an ext4 library instead of NTFS.
#
# vm/test_verify.py first runs swiff-verify's host-side tests.
#
# The self-test reports on the serial console; this script collects the
# results and adds the checks that need the host's view: the scratch
# partition and the games library's session layer hold no plaintext, the
# scratch changes completely across a reboot, updates reach the library as
# the owner's Windows sees it, and PCR 11 equals the value systemd-measure
# predicts for the built UKI. It also presses the keys the self-test asks for
# (Ctrl+Alt+Del, VT switches) on the VM's keyboard, through QEMU's monitor,
# and checks that none of them rebooted the VM.
#
# Usage: vm/run-test.sh [--no-build|--rebuild]
#
# The image is built by vm/build-image.sh only when what goes into it changed;
# --rebuild builds it anyway, and --no-build takes the last build as it is.
# Every run starts from that build through a copy-on-write overlay. Build
# output, caches and the VM's files go to $SWIFF_OS_BUILD_DIR (default
# ~/.cache/swiff-os).
#
# Needs: sudo (mkosi 20 builds as root; the NTFS library is filled through
# ntfs-3g from the build's tools tree), qemu-system-x86_64, swtpm, OVMF
# (/usr/share/OVMF), /dev/kvm, bwrap, python3 with cryptography (for the test's
# Steam manifests). The VM gets 2 GiB of RAM and 4 vCPUs ($SWIFF_VM_CPUS), and
# starts through vm/vm-run.py: it waits for room among this PC's test VMs, and
# a boot is stopped when it outlasts $BOOT_TIMEOUT (600 s) or its console is
# silent for $BOOT_STALL seconds (300).
# Nothing here touches the host's disks, boot entries or UEFI variables: the
# VM's firmware variables are a copy of OVMF's empty template in the run directory.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image_dir=$(cd "$here/../image" && pwd)
# Build output and caches stay outside the source tree (see image/mkosi.conf).
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=$build_dir/output
# The VM's disk overlay, firmware variables, TPM state and logs.
run=$build_dir/vm

ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
# The template without Microsoft keys: the firmware starts in setup mode and
# trusts only what systemd-boot enrols from the image.
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.fd
boot_timeout=${BOOT_TIMEOUT:-600}
boot_stall=${BOOT_STALL:-300}
cpus=${SWIFF_VM_CPUS:-4}

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
	echo "run-test: $*" >&2
	exit 1
}

for tool in qemu-system-x86_64 qemu-img swtpm mkosi bwrap sfdisk mkfs.ext4 debugfs; do
	command -v "$tool" > /dev/null || [ -x "/usr/sbin/$tool" ] || die "$tool not found"
done
python3 -c 'import cryptography' 2> /dev/null || die "python3 cryptography not found (python3-cryptography)"
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
# QEMU normally runs as the calling user. Without access to /dev/kvm it is
# started through sudo and drops to the calling user (-runas) before the VM
# starts, rather than changing the host's device permissions.
qemu=(qemu-system-x86_64)
if [ ! -w /dev/kvm ]; then
	[ -e /dev/kvm ] && sudo -n true 2> /dev/null || die "/dev/kvm is not usable"
	qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")
fi

log "Host-side tests (vm/test_verify.py)"
python3 "$here/test_verify.py" || die "host-side tests failed"

mkdir -p "$run"
# One VM at a time.
exec 9> "$run/lock"
flock -n 9 || die "another run-test.sh is running"

# --- Build -------------------------------------------------------------------
if [ "$build" = 0 ]; then
	disk_src=$out/swiffos-selftest.raw
	uki=$out/swiffos-selftest.efi
else
	log "The test image (vm/build-image.sh selftest)"
	rebuild=()
	[ "$build" = 2 ] && rebuild=(--rebuild)
	base=$("$here/build-image.sh" selftest "${rebuild[@]}")
	disk_src=$base.raw
	uki=$base.efi
fi
tools=$out/ubuntu-tools
[ -e "$disk_src" ] && [ -e "$uki" ] || die "$disk_src or $uki not built (run without --no-build)"
[ -x "$tools/usr/bin/ntfs-3g" ] || die "ntfs-3g missing from the tools tree $tools (rebuild without --no-build)"

# Runs a command from the build's tools tree.
in_tools() {
	bwrap --ro-bind "$tools/usr" /usr \
		--symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
		--bind "$run" "$run" --ro-bind "$here" "$here" --proc /proc --dev /dev --tmpfs /tmp "$@"
}

# --- Prepare the VM ----------------------------------------------------------
log "Preparing the VM in $run"
rm -rf "$run/tpm" "$run"/*.log "$run"/*.raw "$run"/*.qcow2 "$run"/*.fd "$run"/*.img "$run/games" "$run/mnt"
# The build stays as it is: the VM writes to an overlay of it.
qemu-img create -q -f qcow2 -b "$disk_src" -F raw "$run/disk.qcow2"
cp "$ovmf_vars" "$run/vars.fd"
mkdir -p "$run/tpm"

# The shared games library (vm/games-fixture.py): the owner's Steam library on
# NTFS, as their Windows writes it, and the same on ext4 for the last boot.
python3 "$here/games-fixture.py" "$run/games"
truncate -s 1G "$run/games-ntfs.img"
in_tools mkntfs -q -F -f -L SWIFFGAMES "$run/games-ntfs.img" > /dev/null
mkdir -p "$run/mnt"
# Runs a shell script with the NTFS library mounted at $1/mnt ($1 is the run
# directory), as the owner's Windows would change it. ntfs-3g needs root to
# mount; it runs in the foreground (no_detach) so that every write is on the
# image once it has exited.
in_ntfs() { # script
	sudo -n bwrap --ro-bind "$tools/usr" /usr \
		--symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
		--bind "$run" "$run" --proc /proc --dev-bind /dev /dev --tmpfs /tmp \
		sh -c 'ntfs-3g -o no_detach "$1/games-ntfs.img" "$1/mnt" & pid=$!
			for _ in $(seq 100); do mountpoint -q "$1/mnt" && break; sleep 0.1; done
			sh -c "$2" sh "$1"; rc=$?
			umount "$1/mnt"; wait $pid; exit $rc' sh "$run" "$1"
}
in_ntfs 'cp -r "$1/games/library/." "$1/mnt/"' || die "cannot fill the NTFS games library"
mkfs.ext4 -q -L SWIFFGAMES -E root_owner=1000:1000 -d "$run/games/library" "$run/games-ext4.img" 1G
# Owned by the renter's uid (1000) whatever the host user's uid is.
(cd "$run/games/library" && find . -mindepth 1 -printf 'set_inode_field "/%P" uid 1000\nset_inode_field "/%P" gid 1000\n') |
	debugfs -w -f - "$run/games-ext4.img" > /dev/null 2>&1
games_img=$run/games-ntfs.img

# Writes the fixture disk the self-test reads its phase and Steam's part from.
fixtures() { # phase
	echo "$1" > "$run/games/fixtures/phase"
	rm -f "$run/fixtures.img"
	mkfs.ext4 -q -L SWIFFFIX -d "$run/games/fixtures" "$run/fixtures.img" 32M
}
# Prints a file from the NTFS library image.
ntfs_cat() { in_tools ntfscat "$games_img" "$1" 2> /dev/null; }

# Where the scratch partition sits in the disk image, for the host-side checks.
read -r scratch_start scratch_sectors < <(sfdisk -J "$disk_src" |
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

	"$here/vm-run.py" --name "selftest-boot$n" --timeout "$boot_timeout" \
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
		-drive if=none,id=games,format=raw,cache=unsafe,file="$games_img" \
		-device virtio-blk-pci,drive=games \
		-drive if=none,id=fixtures,format=raw,readonly=on,file="$run/fixtures.img" \
		-device virtio-blk-pci,drive=fixtures \
		-netdev "user,id=n0,ipv6-prefix=2001:db8:1::,ipv6-prefixlen=64,guestfwd=tcp:10.0.2.100:80-cmd:echo swiff-lan-reachable" \
		-device virtio-net-pci,netdev=n0 \
		-display none -vga none -monitor "pipe:$run/monitor" \
		-serial "file:$serial" || true
	kill "$swtpm_pid" "$keys_pid" "$monitor_pid" 2> /dev/null || true
	wait "$swtpm_pid" "$keys_pid" "$monitor_pid" 2> /dev/null || true
	grep -q 'SWIFF-SELFTEST DONE' "$serial" || {
		tail -n 40 "$serial" >&2
		die "boot $n did not finish the self-test (serial log: $serial)"
	}
}

# Writes the first $1 bytes of the scratch partition, as the VM left it, to
# $run/scratch.raw (sparse).
scratch_copy() { # bytes
	rm -f "$run/scratch.raw"
	qemu-img convert -O raw "json:{\"driver\":\"raw\",\"offset\":$((scratch_start * 512)),\"size\":$1,\"file\":{\"driver\":\"qcow2\",\"file\":{\"driver\":\"file\",\"filename\":\"$run/disk.qcow2\"}}}" "$run/scratch.raw"
}
# Hashes the first 4 MiB of the scratch partition.
scratch_digest() {
	scratch_copy $((4 * 1024 * 1024))
	sha256sum < "$run/scratch.raw" | cut -d' ' -f1
	rm -f "$run/scratch.raw"
}

# Boots the firmware alone with the same TPM, as the owner's Windows would
# between two rental-mode boots: the TPM's resetCount goes up by one.
foreign_boot() {
	log "Foreign boot (firmware only)"
	swtpm socket --tpm2 --terminate \
		--tpmstate dir="$run/tpm" \
		--ctrl type=unixio,path="$run/tpm/sock" \
		--log file="$run/swtpm-foreign.log" &
	local swtpm_pid=$!
	for _ in $(seq 50); do [ -S "$run/tpm/sock" ] && break; sleep 0.1; done
	"$here/vm-run.py" --name selftest-foreign --timeout 30 -- "${qemu[@]}" \
		-machine q35,smm=on,accel=kvm,kernel-irqchip=split \
		-cpu host -smp "$cpus" -m 2048 \
		-global driver=cfi.pflash01,property=secure,value=on \
		-global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$run/vars.fd" \
		-chardev socket,id=chrtpm,path="$run/tpm/sock" \
		-tpmdev emulator,id=tpm0,chardev=chrtpm \
		-device tpm-crb,tpmdev=tpm0 \
		-drive if=none,id=games,format=raw,file="$games_img" \
		-device virtio-blk-pci,drive=games \
		-nic none -display none -vga none -monitor none \
		-serial "file:$run/serial-foreign.log" || true
	kill "$swtpm_pid" 2> /dev/null || true
	wait "$swtpm_pid" 2> /dev/null || true
}

fixtures bootstrap
boot_vm 1
digest1=$(scratch_digest)
token=$(sed -n 's/^.*SWIFF-SELFTEST INFO marker \(.*\)$/\1/p' "$run/serial-1.log" | tr -d '\r' | tail -n1)
plaintext=absent
scratch_copy $((scratch_sectors * 512))
if [ -n "$token" ] && grep -aqF "$token" "$run/scratch.raw"; then
	plaintext=found
fi
rm -f "$run/scratch.raw"

games_token=$(sed -n 's/^.*SWIFF-SELFTEST INFO games-marker \(.*\)$/\1/p' "$run/serial-1.log" | tr -d '\r' | tail -n1)
games_plaintext=absent
if [ -n "$games_token" ] && grep -aqF "$games_token" "$games_img"; then games_plaintext=found; fi
table_apps=$(ntfs_cat SwiffOS/verified-games.json | python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin)["table"]["apps"])))' 2> /dev/null || true)
container_left=$(in_tools ntfsls -p /SwiffOS "$games_img" 2> /dev/null | grep -c '^session.img$' || true)

fixtures update
boot_vm 2
digest2=$(scratch_digest)

fixtures after-update
boot_vm 3
alpha_exe=$(ntfs_cat steamapps/common/Alpha/Alpha.exe | sha256sum | cut -d' ' -f1)
alpha_v2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["v2"]["1001"]["Alpha.exe"])' "$run/games/fixtures/expect.json")

# The owner's Windows plants a DLL in Alpha and changes a file of Delta,
# keeping its size and putting its mtime back.
in_ntfs 'cp "$1/games/tamper/Alpha-version.dll" "$1/mnt/steamapps/common/Alpha/bin/version.dll" &&
	d=$1/mnt/steamapps/common/Delta/data/d.pak && t=$(stat -c %y "$d") &&
	cat "$1/games/tamper/Delta-d.pak" > "$d" && touch -d "$t" "$d"' || die "cannot change the NTFS games library"
foreign_boot
fixtures tampered
boot_vm 4

fixtures still-blocked
boot_vm 5

# The table key stops unsealing, as after a Secure Boot update: one character
# of its credential is changed in place. Sets locked_sha to the credential's
# sha256 and gives it to the self-test.
lock_key() {
	ntfs_cat SwiffOS/table-key.cred > "$run/key.cred"
	python3 -c 'import sys
data = bytearray(open(sys.argv[1], "rb").read())
i = next(i for i in range(len(data) // 2, len(data)) if chr(data[i]).isalnum())
data[i] = ord("A") if data[i] != ord("A") else ord("B")
open(sys.argv[1], "wb").write(data)' "$run/key.cred"
	in_tools ntfscp -f "$games_img" "$run/key.cred" SwiffOS/table-key.cred > /dev/null
	locked_sha=$(sha256sum < "$run/key.cred")
	echo "$locked_sha" > "$run/games/fixtures/key-sha256"
}
lock_key
key_locked=$locked_sha
fixtures key-locked
boot_vm 6
key_after=$(ntfs_cat SwiffOS/table-key.cred | sha256sum)
rebootstrap_apps=$(ntfs_cat SwiffOS/verified-games.json | python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin)["table"]["apps"])))' 2> /dev/null || true)

fixtures table-newer
boot_vm 7
sed -n 's/^.*SWIFF-SELFTEST INFO games-table-sha256 \(.*\)$/\1/p' "$run/serial-7.log" | tr -d '\r' | tail -n1 > "$run/games/fixtures/table-sha256"
fixtures table-unreadable
boot_vm 8
fixtures table-corrupt
boot_vm 9
replaced_apps=$(ntfs_cat SwiffOS/verified-games.json | python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin)["table"]["apps"])))' 2> /dev/null || true)

# The key is locked again, and the TPM cannot seal a new one (the self-test's
# systemd-creds): the owner's bootstrap must leave the key and table as they are.
lock_key
sealfail_key=$locked_sha
sealfail_table=$(ntfs_cat SwiffOS/verified-games.json | sha256sum)
fixtures seal-fails-rebootstrap
boot_vm 10
sealfail_key_after=$(ntfs_cat SwiffOS/table-key.cred | sha256sum)
sealfail_table_after=$(ntfs_cat SwiffOS/verified-games.json | sha256sum)
sealfail_tmp=$(in_tools ntfsls -p /SwiffOS "$games_img" 2> /dev/null | grep -c '^table-key\.cred\.' || true)
sealfail_logged=$(grep -ac "nothing promoted: the owner's bootstrap could not seal a new table key" "$run/serial-10.log" || true)

# A first boot for the table: no key and no table, and the TPM cannot seal a key.
in_ntfs 'rm -f "$1/mnt/SwiffOS/table-key.cred" "$1/mnt/SwiffOS/verified-games.json"' || die "cannot remove the table key"
fixtures seal-fails-first
boot_vm 11
firstfail_left=$(in_tools ntfsls -p /SwiffOS "$games_img" 2> /dev/null | grep -E '^(table-key\.cred|verified-games\.json)' | paste -sd' ' - || true)

games_img=$run/games-ext4.img
fixtures ext4
boot_vm 12
ext4_apps=$(debugfs -R "cat /SwiffOS/verified-games.json" "$games_img" 2> /dev/null |
	python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin)["table"]["apps"])))' 2> /dev/null || true)

# --- Expected PCR 11 -----------------------------------------------------------
# systemd-measure (from the build's tools tree) predicts PCR 11 for this UKI
# after the boot phases enter-initrd, leave-initrd, sysinit and ready.
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

for n in 1 2 3 4 5 6 7 8 9 10 11 12; do
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
if [ -n "$games_token" ] && [ "$games_plaintext" = absent ]; then
	result PASS games-session-encrypted "renter's marker not in the NTFS library's raw bytes"
else
	result FAIL games-session-encrypted "marker '${games_token:-missing}' $games_plaintext in the raw NTFS library"
fi
if [ "$table_apps" = "1001 1002 1003 1004" ] && [ "$container_left" = 0 ]; then
	result PASS games-bootstrap-on-ntfs "verified table on the NTFS library: $table_apps; session layer removed"
else
	result FAIL games-bootstrap-on-ntfs "table apps '${table_apps}', session.img left: $container_left"
fi
if [ "$alpha_exe" = "$alpha_v2" ]; then
	result PASS games-update-on-ntfs "the verified update is on the NTFS library as Windows reads it"
else
	result FAIL games-update-on-ntfs "Alpha.exe on the library is $alpha_exe, not $alpha_v2"
fi
if [ "$rebootstrap_apps" = 1002 ] && [ "$key_after" != "$key_locked" ]; then
	result PASS games-rebootstrap-new-key "the owner's bootstrap sealed a new table key; table apps: $rebootstrap_apps"
else
	result FAIL games-rebootstrap-new-key "table apps '${rebootstrap_apps}', key replaced: $([ "$key_after" != "$key_locked" ] && echo yes || echo no)"
fi
if [ "$replaced_apps" = 1002 ]; then
	result PASS games-bootstrap-replaces-corrupt "the owner's bootstrap replaced the corrupt table; table apps: $replaced_apps"
else
	result FAIL games-bootstrap-replaces-corrupt "table apps '${replaced_apps}'"
fi
if [ "$sealfail_logged" -ge 1 ] && [ "$sealfail_table_after" = "$sealfail_table" ]; then
	result PASS games-seal-fails-nothing-promoted "the bootstrap's promotion logged 'nothing promoted'; the table is unchanged"
else
	result FAIL games-seal-fails-nothing-promoted "'nothing promoted' logged $sealfail_logged times, table unchanged: $([ "$sealfail_table_after" = "$sealfail_table" ] && echo yes || echo no)"
fi
if [ "$sealfail_key_after" = "$sealfail_key" ] && [ "$sealfail_tmp" = 0 ]; then
	result PASS games-seal-fails-keeps-key "the old credential is kept byte for byte; no temporary credential left"
else
	result FAIL games-seal-fails-keeps-key "credential kept: $([ "$sealfail_key_after" = "$sealfail_key" ] && echo yes || echo no), temporary credentials left: $sealfail_tmp"
fi
if [ -z "$firstfail_left" ]; then
	result PASS games-first-seal-fails-no-key "no table key, temporary credential or table on the library"
else
	result FAIL games-first-seal-fails-no-key "left on the library: $firstfail_left"
fi
if [ "$ext4_apps" = "1001 1003" ]; then
	result PASS games-bootstrap-on-ext4 "verified table on the ext4 library: $ext4_apps"
else
	result FAIL games-bootstrap-on-ext4 "table apps '${ext4_apps}'"
fi
disk_bytes=$(stat -c %s "$disk_src")
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
