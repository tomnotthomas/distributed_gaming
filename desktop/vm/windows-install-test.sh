#!/usr/bin/env bash
# Rental mode's real installer, tested on real Windows in a VM.
#
# The host app's installer (rental-exec.cjs, rental-worker.cjs) changes a PC's
# disk and firmware from Windows. This runs it, unchanged, on Windows 11 in
# QEMU/KVM, with OVMF and Microsoft's Secure Boot keys, a software TPM
# (swtpm), and BitLocker on C:, the way a laptop comes:
#
#   prepare   once: Microsoft's free Windows 11 Enterprise evaluation, installed
#             unattended (windows/autounattend.xml, windows/setup.ps1), with
#             OpenSSH and Node.js to drive it; then, on a boot without the
#             install discs, BitLocker encrypting C: with the TPM. Kept as the
#             base every test starts from; an interrupted prepare resumes.
#   test      from a copy of the base:
#               1. the app's read of the PC, and its one elevation (UAC's
#                  Start-Process -Verb RunAs, from the logged-on user)
#               2. install: BitLocker suspended, C: shrunk, Swiff OS's
#                  partitions added and written, its boot entry, the MOK
#                  request, BootNext, restart
#               3. MokManager: the owner's confirmation with the code
#                  (mok-drive.py on the serial console), then Windows again
#               4. Swiff OS once (BootNext): shim, Swiff's systemd-boot, the
#                  UKI, Swiff OS's self-test; then Windows again
#               5. Swiff's key removed at MokManager (while its boot partition
#                  is still there), then the uninstall: boot entry,
#                  partitions, C:'s space, Fast Startup, BitLocker, the
#                  record; then Windows again
#             Windows must come back after each restart without asking for its
#             BitLocker recovery key, with its files.
#
# Usage: vm/windows-install-test.sh prepare|test
#
# Needs: sudo (QEMU, when /dev/kvm is not writable), qemu-system-x86_64,
# qemu-img, swtpm, OVMF's Secure Boot build with Microsoft's keys, xorriso,
# ssh, curl, a Python with virt-firmware ($VIRT_FW_PYTHON), node, and the
# image set (swiff-os/image-set.sh) of the self-test build in $SWIFF_IMAGE_SET.
# The VM takes 2 GiB of memory ($SWIFF_WIN_VM_MEM, in MiB) and up to ~60 GB of disk under $SWIFF_WIN_VM_DIR.
# Nothing here touches the host's disks, boot entries or firmware variables.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
desktop=$here/..
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
dir=${SWIFF_WIN_VM_DIR:-$build_dir/win-vm}
image_set=${SWIFF_IMAGE_SET:-$build_dir/image-set}
python=${VIRT_FW_PYTHON:-python3}
ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.ms.fd
iso=${WIN_ISO:-$dir/win11-eval.iso}
# Microsoft's Windows 11 Enterprise evaluation, English (United States), from the Evaluation Center.
iso_url='https://go.microsoft.com/fwlink/?LinkId=2382600&clcid=0x409&culture=en-us&country=us'
node_zip=node-v22.23.3-win-x64.zip
node_sha=2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71
ssh_url=https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64.zip
ssh_sha=23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5
port=${SWIFF_WIN_SSH_PORT:-22422}
# Under nested KVM (WSL2 on Hyper-V), a Windows guest with more than 2 GiB dies
# in SMM ("KVM: entry failed") seconds into booting, and Secure Boot needs SMM:
# the VM gets 2 GiB, and Windows Setup's 4 GB check is skipped (autounattend.xml).
mem=${SWIFF_WIN_VM_MEM:-2048}

log() { printf '\n== %s\n' "$*"; }
die() {
	echo "windows-install-test: $*" >&2
	exit 1
}

for tool in qemu-system-x86_64 qemu-img swtpm xorriso ssh scp curl node mdir; do
	command -v "$tool" > /dev/null || die "$tool not found"
done
fsck_fat=$(command -v fsck.fat || echo /usr/sbin/fsck.fat)
[ -x "$fsck_fat" ] || die "fsck.fat not found"
"$python" -c 'import virt.firmware' 2> /dev/null || die "$python has no virt-firmware (set VIRT_FW_PYTHON)"
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF's Secure Boot build with Microsoft's keys not found"
qemu=(qemu-system-x86_64)
if [ ! -w /dev/kvm ]; then
	sudo -n true 2> /dev/null || die "needs a writable /dev/kvm, or sudo without a password for QEMU"
	qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")
fi
mkdir -p "$dir"
exec 9> "$dir/lock"
flock -n 9 || die "another windows-install-test.sh is running"

# --- the VM ------------------------------------------------------------------------------

run=$dir/run
key=$dir/ssh-key
opts=(-i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10)
on_vm() { ssh "${opts[@]}" -p "$port" swiff@127.0.0.1 "$@"; }
to_vm() { scp -q -r "${opts[@]}" -P "$port" "$@"; }

# One VM at a time, and room for it.
room() {
	! pgrep qemu-system-x86 > /dev/null || die "another VM is running"
	local avail
	avail=$(free -m | awk '/^Mem:/ { print $7 }')
	[ "$avail" -ge $((mem + 1024)) ] || die "only ${avail} MiB of memory available, $((mem + 1024)) needed"
}

# Starts the VM in the background on disk $1, firmware variables $2, TPM state $3; more QEMU arguments after.
vm_start() { # disk vars tpm-dir [qemu args...]
	local disk=$1 vars=$2 tpm=$3
	shift 3
	room
	rm -f "$run/serial.sock" "$run/monitor.sock" "$run/tpm.sock"
	swtpm socket --tpm2 --tpmstate dir="$tpm" --ctrl type=unixio,path="$run/tpm.sock" \
		--log file="$run/swtpm.log" --terminate 9>&- &
	tpm_pid=$!
	for _ in $(seq 50); do [ -S "$run/tpm.sock" ] && break; sleep 0.1; done
	"${qemu[@]}" -name swiff-win \
		-machine q35,smm=on,accel=kvm -cpu host,-svm,-vmx,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time \
		-smp "${SWIFF_WIN_VM_CPUS:-2}" -m "$mem" \
		-global driver=cfi.pflash01,property=secure,value=on -global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$vars" \
		-chardev socket,id=chrtpm,path="$run/tpm.sock" -tpmdev emulator,id=tpm0,chardev=chrtpm \
		-device tpm-crb,tpmdev=tpm0 \
		-drive if=none,id=hd,format=qcow2,file="$disk" -device ide-hd,drive=hd,bus=ide.0 \
		-netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$port"-:22 -device e1000e,netdev=n0,romfile= \
		-usb -device usb-tablet -vga std -display none \
		-monitor unix:"$run/monitor.sock",server=on,wait=off \
		-chardev socket,id=ser0,path="$run/serial.sock",server=on,wait=off,logfile="$run/serial.log",logappend=on \
		-serial chardev:ser0 \
		"$@" > "$run/qemu.log" 2>&1 9>&- &
	vm_pid=$!
	for _ in $(seq 100); do [ -S "$run/monitor.sock" ] && [ -S "$run/serial.sock" ] && break; sleep 0.1; done
	# QEMU made its sockets before it dropped root (sudo ... -runas): hand them to this user.
	[ -O "$run/monitor.sock" ] || sudo -n chown "$(id -u):$(id -g)" "$run/monitor.sock" "$run/serial.sock" "$run/serial.log"
	sleep 1
	[ -d "/proc/$vm_pid" ] || die "QEMU did not start: $(cat "$run/qemu.log")"
}
monitor() { printf '%s\n' "$*" | python3 -c '
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(sys.stdin.buffer.read())
# QEMU reads the command only while the connection stays open.
time.sleep(0.3); s.close()' "$run/monitor.sock"; }
screenshot() { monitor "screendump $run/$1.ppm" || true; }
# Waits until the VM has powered off, up to $1 seconds.
vm_wait_off() { # seconds
	local end=$((SECONDS + $1))
	while [ -d "/proc/$vm_pid" ]; do
		[ "$SECONDS" -lt "$end" ] || { screenshot "timeout-$SECONDS"; return 1; }
		sleep 5
	done
}
vm_kill() {
	sudo -n pkill -f '[q]emu-system-x86_64 .*-name swiff-win' 2> /dev/null || true
	kill "${tpm_pid:-}" 2> /dev/null || true
}
# Waits until Windows answers on SSH, up to $1 seconds.
ssh_wait() { # seconds
	local end=$((SECONDS + $1))
	until on_vm 'exit 0' 2> /dev/null; do
		[ -d "/proc/$vm_pid" ] || return 1
		[ "$SECONDS" -lt "$end" ] || { screenshot "no-ssh-$SECONDS"; return 1; }
		sleep 10
	done
}

# --- prepare: Windows, once ------------------------------------------------------------------

prepare() {
	mkdir -p "$run"
	trap 'vm_kill' EXIT
	if [ ! -s "$iso" ]; then
		log "Downloading the Windows 11 Enterprise evaluation from Microsoft (8 GB)"
		curl -fL -C - -o "$iso.part" "$iso_url" && mv "$iso.part" "$iso"
	fi
	[ -s "$dir/node.zip" ] || curl -fsSL -o "$dir/node.zip" "https://nodejs.org/dist/v22.23.3/$node_zip"
	[ -s "$dir/openssh.zip" ] || curl -fsSL -o "$dir/openssh.zip" "$ssh_url"
	echo "$node_sha  $dir/node.zip" | sha256sum -c --quiet || die "node.zip is not the pinned one"
	echo "$ssh_sha  $dir/openssh.zip" | sha256sum -c --quiet || die "openssh.zip is not the pinned one"
	[ -e "$key" ] || ssh-keygen -q -t ed25519 -N '' -C swiff-win-vm -f "$key"
	local media=$run/setup
	rm -rf "$media" && mkdir -p "$media"
	cp "$here/windows/autounattend.xml" "$here/windows/setup.ps1" "$dir/node.zip" "$dir/openssh.zip" "$media/"
	cp "$key.pub" "$media/authorized_keys"
	xorriso -as mkisofs -quiet -V SWIFFSETUP -J -r -o "$run/setup.iso" "$media"
	if [ ! -e "$dir/base.installed" ]; then
		install_windows
		touch "$dir/base.installed"
	fi
	if [ ! -e "$dir/base.ready" ]; then
		encrypt_c
		touch "$dir/base.ready"
	fi
	log "Windows is ready: base in $dir"
}

# Windows Setup, unattended, until setup.ps1 powers the VM off.
install_windows() {
	rm -f "$dir/base.qcow2" "$dir/base-vars.fd"
	rm -rf "$dir/base-tpm" && mkdir -p "$dir/base-tpm"
	qemu-img create -q -f qcow2 "$dir/base.qcow2" 100G
	cp "$ovmf_vars" "$dir/base-vars.fd"
	log "Installing Windows (unattended; about 25 minutes under nested KVM)"
	vm_start "$dir/base.qcow2" "$dir/base-vars.fd" "$dir/base-tpm" \
		-drive if=none,id=cd0,media=cdrom,file="$iso" -device ide-cd,drive=cd0,bus=ide.1,bootindex=0 \
		-drive if=none,id=cd1,media=cdrom,file="$run/setup.iso" -device ide-cd,drive=cd1,bus=ide.2
	# "Press any key to boot from CD or DVD" comes within seconds (the DVD boots
	# first): press for 25 s, and stop before Setup's own screens, where a space
	# would press their Cancel.
	for _ in $(seq 25); do monitor "sendkey spc" || true; sleep 1; done
	vm_wait_off 14400 || { vm_kill; die "Windows did not finish setting up within 4 hours (screens in $run)"; }
}

# BitLocker on C: with the TPM and a recovery password (kept in the VM, for a
# look at a recovery screen), fully encrypted, as on a laptop that came with
# Device Encryption. setup.ps1 must have finished first.
encrypt_c() {
	log "BitLocker on C:"
	vm_start "$dir/base.qcow2" "$dir/base-vars.fd" "$dir/base-tpm"
	ssh_wait 1800 || { vm_kill; die "the installed Windows does not answer on SSH (screens in $run)"; }
	on_vm 'if (-not (Test-Path C:\swiff-setup-done.txt)) { exit 1 }' || { vm_kill; die "setup.ps1 did not finish (C:\swiff-setup.log in the VM)"; }
	# Windows may have started Device Encryption on its own (a clear key, protection off): either way,
	# C: ends up encrypted with a TPM protector, a recovery password, and protection on.
	on_vm '$ErrorActionPreference = "Stop"
$has = { param($type) @((Get-BitLockerVolume -MountPoint C:).KeyProtector | Where-Object KeyProtectorType -eq $type).Count -gt 0 }
if ((Get-BitLockerVolume -MountPoint C:).VolumeStatus -eq "FullyDecrypted") {
  Enable-BitLocker -MountPoint C: -TpmProtector -UsedSpaceOnly -SkipHardwareTest | Out-Null
} elseif (-not (& $has "Tpm")) { Add-BitLockerKeyProtector -MountPoint C: -TpmProtector | Out-Null }
if (-not (& $has "RecoveryPassword")) { Add-BitLockerKeyProtector -MountPoint C: -RecoveryPasswordProtector | Out-Null }
((Get-BitLockerVolume -MountPoint C:).KeyProtector | Where-Object KeyProtectorType -eq RecoveryPassword).RecoveryPassword | Set-Content C:\swiff-recovery.txt
while ((Get-BitLockerVolume -MountPoint C:).VolumeStatus -ne "FullyEncrypted") { Start-Sleep 10 }
Resume-BitLocker -MountPoint C: | Out-Null
manage-bde -status C:
if ((Get-BitLockerVolume -MountPoint C:).ProtectionStatus -ne "On") { exit 1 }' || { vm_kill; die "BitLocker does not protect C:"; }
	on_vm 'Stop-Computer -Force' || true
	vm_wait_off 600 || { vm_kill; die "the installed Windows did not shut down"; }
}

# --- test --------------------------------------------------------------------------------------

test_run() {
	[ -s "$dir/base.qcow2" ] || die "no Windows base: run prepare first"
	[ -s "$image_set/swiffos.json" ] || die "no image set in $image_set: run swiff-os/image-set.sh"
	rm -rf "$run" && mkdir -p "$run"
	qemu-img create -q -f qcow2 -b "$dir/base.qcow2" -F qcow2 "$run/disk.qcow2"
	cp "$dir/base-vars.fd" "$run/vars.fd"
	cp -r "$dir/base-tpm" "$run/tpm"
	trap 'vm_kill' EXIT
	printf '#!/bin/sh\nexec %q %q "$@"\n' "$python" "$here/boot-vars.py" > "$run/boot-vars"
	chmod +x "$run/boot-vars"
	local cert_hex
	cert_hex=$(od -An -v -tx1 "$image_set/swiffos-key.cer" | tr -d ' \n')
	local cli='node C:\swiff\desktop\rental-cli.cjs'
	local img='C:\swiff\image'
	local fail=0

	# Prints one result row; a FAIL fails the test.
	result() { printf '%-4s  %-28s %s\n' "$1" "$2" "$3" | tee -a "$run/results.txt"; [ "$1" = PASS ] || fail=1; }
	expect() { # name detail command...
		local name=$1 detail=$2
		shift 2
		if "$@" > /dev/null 2>&1; then result PASS "$name" "$detail"; else result FAIL "$name" "$detail"; fi
	}
	# A value from the last JSON line of a file that has KEY: node's view of it.
	json() { node -e 'const fs=require("fs"); const lines=fs.readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); const hit=lines.reverse().find(l=>process.argv[2] in l); console.log(JSON.stringify(eval("hit"+process.argv[3])))' "$@"; }
	# Waits for Windows after a restart: the firmware has to start it, and BitLocker must not ask.
	windows_back() { # name
		if ssh_wait 1800; then result PASS "$1" "Windows answered after the restart"; else
			result FAIL "$1" "Windows did not come back (screens in $run)"
			return 1
		fi
	}

	log "Windows"
	vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
	ssh_wait 1800 || die "Windows did not answer on SSH"
	on_vm 'New-Item -ItemType Directory -Force C:\swiff\desktop | Out-Null; $m = [guid]::NewGuid().ToString(); Set-Content C:\swiff-marker.txt $m; $m' | tr -d '\r' > "$run/marker"
	on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-before.txt"
	on_vm '(Get-Partition -DriveLetter C).Size' | tr -d '\r\n' > "$run/c-before"
	log "Copying the installer and the image set"
	to_vm "$desktop"/{rental-cli,rental-exec,rental-worker,rental,image-set,gpt,efi,pc,probe}.cjs swiff@127.0.0.1:'C:/swiff/desktop/'
	to_vm "$image_set" swiff@127.0.0.1:'C:/swiff/image'

	log "1. What the app reads, and its one elevation"
	on_vm "$cli read" | tr -d '\r' > "$run/read-before.json"
	local seen
	seen="$(json "$run/read-before.json" read '.read.facts.secureBoot') $(json "$run/read-before.json" read '.read.targets[0].id')"
	expect read "the app reads Secure Boot on and room on C: ($seen)" test "$seen" = 'true "shrink:C"'
	# From the logged-on user's own session, unelevated, as the app runs: Start-Process -Verb RunAs.
	on_vm "Set-Content C:\\swiff\\uac-in.txt 'elevate','quit'; schtasks /create /tn swiff-uac /tr 'cmd /c C:\\node\\node.exe C:\\swiff\\desktop\\rental-cli.cjs serve --image $img < C:\\swiff\\uac-in.txt > C:\\swiff\\uac-out.txt 2>&1' /sc once /st 23:59 /it /rl LIMITED /f | Out-Null; schtasks /run /tn swiff-uac | Out-Null; Start-Sleep 30; Get-Content C:\\swiff\\uac-out.txt" | tr -d '\r' > "$run/uac.json"
	expect elevation "the worker started through UAC's RunAs and said hello" grep -q '"elevated":true' "$run/uac.json"

	log "2. Install"
	on_vm "$cli run install --image $img" | tr -d '\r' | tee "$run/install.json" | grep -E '"(outcome|error)"' || true
	expect install "every install step ran" grep -q '"outcome":{"status":"done"' "$run/install.json"
	local code
	code=$(json "$run/install.json" plan '.plan.mok.code' | tr -d '"' || true)

	log "3. MokManager: confirm Swiff's key with $code"
	expect mok-confirmed "the owner's confirmation at MokManager went through" \
		"$python" "$here/mok-drive.py" "$run/mok-confirm.log" confirm "$code" --loose --socket "$run/serial.sock"
	windows_back windows-after-mok
	on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-1"
	expect files-kept-1 "C: holds its file after the install" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-1"
	on_vm "$cli read" | tr -d '\r' > "$run/read-installed.json"
	expect installed "the app reads Swiff OS as installed" test "$(json "$run/read-installed.json" read '.read.installed')" = true
	on_vm 'Get-Partition -DiskNumber 0 | Select-Object PartitionNumber, Offset, Size, GptType, Guid | ConvertTo-Json -Compress' | tr -d '\r' > "$run/partitions-installed.json"
	expect partitions "Windows sees Swiff OS's 6 partitions after its 4" \
		test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$run/partitions-installed.json")" = 10
	on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-installed.txt"

	log "4. Swiff OS once"
	on_vm "$cli run once --image $img" | tr -d '\r' > "$run/once.json"
	expect once "BootNext set and the PC restarting" grep -q '"outcome":{"status":"done"' "$run/once.json"
	expect swiffos-booted "shim, systemd-boot and the UKI started Swiff OS's self-test" \
		"$python" "$here/mok-drive.py" "$run/swiffos.log" wait "SWIFF-SELFTEST DONE" 900 --socket "$run/serial.sock"
	vm_wait_off 300 || vm_kill
	tr -d '\r' < "$run/serial.log" | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -a 'SWIFF-SELFTEST' > "$run/selftest.txt" || true
	expect swiffos-secure-boot "Swiff OS ran with Secure Boot on" grep -q 'SWIFF-SELFTEST PASS secure-boot' "$run/selftest.txt"
	expect swiffos-verity-root "Swiff OS's root is its verity device" grep -q 'SWIFF-SELFTEST PASS root-is-verity' "$run/selftest.txt"
	"$run/boot-vars" show "$run/vars.fd" > "$run/vars-swiffos.txt"
	expect mok-enrolled "MokList holds Swiff's key, as the confirmation left it" grep -q "^MokList: .*$cert_hex" "$run/vars-swiffos.txt"
	# Windows has run twice beside Swiff OS's ESP: it must still be a sound FAT, untouched by chkdsk.
	local esp_at esp_bytes
	read -r esp_at esp_bytes < <(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/).pop()).read; const p=r.facts.install.partitions.find(p=>p.role==="esp"); console.log(p.offset, p.bytes)' "$run/read-installed.json")
	qemu-img convert -O raw "json:{\"driver\":\"raw\",\"offset\":$esp_at,\"size\":$esp_bytes,\"file\":{\"driver\":\"qcow2\",\"file\":{\"driver\":\"file\",\"filename\":\"$run/disk.qcow2\"}}}" "$run/esp.raw"
	expect esp-sound "Swiff OS's ESP passes fsck.fat after Windows ran beside it" "$fsck_fat" -n "$run/esp.raw"
	expect esp-no-chkdsk "no FOUND.000 from Windows' chkdsk on it" bash -c "! MTOOLS_SKIP_CHECK=1 mdir -i '$run/esp.raw' ::/ | grep -q FOUND"
	rm -f "$run/esp.raw"
	vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
	windows_back windows-after-swiffos
	on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-2"
	expect files-kept-2 "C: holds its file after Swiff OS ran" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-2"

	log "5. Swiff's key removed, then the uninstall"
	# The key first: MokManager, which removes it, is on Swiff OS's boot partition.
	on_vm "$cli run unkey --image $img" | tr -d '\r' | tee "$run/unkey.json" | grep -E '"(outcome|error)"' || true
	expect unkey "the key's removal queued and the PC restarting" grep -q '"outcome":{"status":"done"' "$run/unkey.json"
	code=$(json "$run/unkey.json" plan '.plan.mok.code' | tr -d '"' || true)
	expect mok-removed "the owner's removal at MokManager went through" \
		"$python" "$here/mok-drive.py" "$run/mok-remove.log" remove "$code" --loose --socket "$run/serial.sock"
	windows_back windows-after-unkey
	on_vm "$cli run uninstall --image $img" | tr -d '\r' | tee "$run/uninstall.json" | grep -E '"(outcome|error)"' || true
	expect uninstall "every uninstall step ran" grep -q '"outcome":{"status":"done"' "$run/uninstall.json"
	# Windows starts as before, from the firmware's own entry, without its recovery key.
	on_vm 'Restart-Computer -Force' || true
	sleep 30
	windows_back windows-after-uninstall
	on_vm '(Get-Partition -DriveLetter C).Size' | tr -d '\r\n' > "$run/c-after"
	expect c-grown "C: is its size again: $(cat "$run/c-after") bytes" cmp -s "$run/c-before" "$run/c-after"
	on_vm 'Get-Partition -DiskNumber 0 | Measure-Object | ForEach-Object Count' | tr -d '\r\n' > "$run/partitions-after"
	expect partitions-gone "Windows' 4 partitions, and no others" test "$(cat "$run/partitions-after")" = 4
	on_vm "$cli read" | tr -d '\r' > "$run/read-after.json"
	expect forgotten "the app reads Swiff OS as not installed" test "$(json "$run/read-after.json" read '.read.facts.install')" = null
	on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-3"
	expect files-kept-3 "C: holds its file after the uninstall" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-3"
	on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-after.txt"
	expect bitlocker-on "BitLocker protects C: again" grep -q 'Protection On' "$run/bitlocker-after.txt"
	on_vm 'Stop-Computer -Force' || true
	vm_wait_off 300 || vm_kill
	"$run/boot-vars" show "$run/vars.fd" | tee "$run/vars-after.txt"
	expect no-boot-entry "the firmware has no Swiff OS entry" bash -c "! grep -q 'Swiff OS' '$run/vars-after.txt'"
	expect key-removed "MokList no longer holds Swiff's key" \
		bash -c "! grep -q '$cert_hex' '$run/vars-after.txt'"

	echo
	if [ "$fail" = 0 ]; then echo "Windows install VM test: PASS"; else
		echo "Windows install VM test: FAIL (logs in $run)"
		exit 1
	fi
}

case "${1:-}" in
	prepare) prepare ;;
	test) test_run ;;
	*) die "usage: windows-install-test.sh prepare|test" ;;
esac
