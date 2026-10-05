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
# Usage: vm/windows-install-test.sh prepare|test     ($SWIFF_SCENARIOS="2 3" runs only those)
#
# Needs: sudo (QEMU, when /dev/kvm is not writable), qemu-system-x86_64,
# qemu-img, swtpm, OVMF's Secure Boot build with Microsoft's keys, xorriso,
# ssh, curl, a Python with virt-firmware ($VIRT_FW_PYTHON), node, and the
# image set (swiff-os/image-set.sh) of the self-test build in $SWIFF_IMAGE_SET,
# and Electron for Windows in $SWIFF_WIN_ELECTRON (the dist folder of the
# `electron` package as Windows' npm installs it): the console and its worker
# run on Electron's own Node, as in Swiff Host, whose Node differs from a
# console's (it took \\.\PhysicalDrive0 for a share root).
# The VM takes 2 GiB of memory ($SWIFF_WIN_VM_MEM, in MiB) and up to ~60 GB of disk under $SWIFF_WIN_VM_DIR.
# Set $SWIFF_VM_CGROUP to a cgroup v2 folder with memory.swap.max 0 (sudo to move QEMU in) when
# the host swaps under the image's copy.
# Nothing here touches the host's disks, boot entries or firmware variables.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
desktop=$here/..
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
dir=${SWIFF_WIN_VM_DIR:-$build_dir/win-vm}
image_set=${SWIFF_IMAGE_SET:-$build_dir/image-set}
electron_dir=${SWIFF_WIN_ELECTRON:-}
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
		-drive if=none,id=hd,format=qcow2,file="$disk",cache=none -device ide-hd,drive=hd,bus=ide.0 \
		-netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$port"-:22 -device e1000e,netdev=n0,romfile= \
		-usb -device usb-tablet -vga std -display none \
		-monitor unix:"$run/monitor.sock",server=on,wait=off \
		-chardev socket,id=ser0,path="$run/serial.sock",server=on,wait=off,logfile="$run/serial.log",logappend=on \
		-serial chardev:ser0 \
		"$@" > "$run/qemu.log" 2>&1 9>&- &
	vm_pid=$!
	# Out of swap: copying gigabytes into the guest fills the host's page cache, and a guest
	# whose memory the host swaps out stalls until its network driver gives up. A cgroup
	# (v2) with memory.swap.max 0, made beforehand, keeps it in memory: $SWIFF_VM_CGROUP.
	if [ -n "${SWIFF_VM_CGROUP:-}" ]; then
		echo "$vm_pid" | sudo -n tee "$SWIFF_VM_CGROUP/cgroup.procs" > /dev/null || die "cannot move QEMU into $SWIFF_VM_CGROUP"
	fi
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
	[ -x "$electron_dir/electron.exe" ] || die "no Electron for Windows in \$SWIFF_WIN_ELECTRON"
	# The app's runtime: Electron as Node, which the worker it starts inherits. Electron is a
	# windowed program: PowerShell waits for it and hands on its output only through a pipe.
	local cli='function swiff-cli { $env:ELECTRON_RUN_AS_NODE = 1; & C:\swiff\electron\electron.exe C:\swiff\desktop\rental-cli.cjs @args | Write-Output }; swiff-cli'
	local img='C:\swiff\image'
	local fail=0

	# Prints one result row; a FAIL fails the test.
	result() { printf '%-4s  %-30s %s\n' "$1" "$2" "$3" | tee -a "$run/results.txt"; [ "$1" = PASS ] || fail=1; }
	expect() { # name detail command...
		local name=$1 detail=$2
		shift 2
		if "$@" > /dev/null 2>&1; then result PASS "$name" "$detail"; else result FAIL "$name" "$detail"; fi
	}
	# A section of the results: one scenario.
	scenario() { log "$*"; printf '\n## %s\n' "$*" >> "$run/results.txt"; }
	# Whether scenario N runs: all of them, or those in $SWIFF_SCENARIOS ("2 3"). 5 to 10 build on
	# each other: from a fresh copy, each needs the ones before it from 5 on.
	want() { [ -z "${SWIFF_SCENARIOS:-}" ] || [[ " $SWIFF_SCENARIOS " == *" $1 "* ]]; }
	# A value from the last JSON line of a file that has KEY: node's view of it.
	json() { node -e 'const fs=require("fs"); const lines=fs.readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); const hit=lines.reverse().find(l=>process.argv[2] in l); console.log(JSON.stringify(eval("hit"+process.argv[3])))' "$@"; }
	# Waits for Windows after a restart: the firmware has to start it, and BitLocker must not ask.
	windows_back() { # name
		if ssh_wait 1800; then result PASS "$1" "Windows answered after the restart"; else
			result FAIL "$1" "Windows did not come back (screens in $run)"
			return 1
		fi
	}
	# What the app reads now, with this start's boot trail, into $run/read-NAME.json.
	read_as() { on_vm "$cli read" | tr -d '\r' > "$run/read-$1.json" || true; }
	# PCR 7 as this start's TCG log replays it: what Windows Hello's PIN and BitLocker are sealed to.
	pcr7() { # name
		local log
		log=$(on_vm '(Get-ChildItem C:\Windows\Logs\MeasuredBoot\*.log | Sort-Object LastWriteTime | Select-Object -Last 1).FullName' | tr -d '\r\n')
		scp -q "${opts[@]}" -P "$port" "swiff@127.0.0.1:${log//\\//}" "$run/mb-$1.log" || true
		python3 "$here/pcr7.py" "$run/mb-$1.log" || echo none
	}
	# Where the app would put the key now: rental-key.cjs on this start, for a request queued before it.
	key_state() {
		on_vm '$env:ELECTRON_RUN_AS_NODE = 1; & C:\swiff\electron\electron.exe C:\swiff\vm\key-state.cjs | Write-Output' | tr -d '\r\n'
	}

	# The serve console, fed through a file: one elevated worker for several commands.
	serve() { # name commands...
		local name=$1
		shift
		printf '%s\n' "$@" quit | on_vm "Set-Content C:\\swiff\\cmd-$name.txt -Value (\$input | Out-String).Trim()"
		on_vm "$cli serve --image $img --commands C:\\swiff\\cmd-$name.txt" | tr -d '\r' > "$run/serve-$name.json" || true
	}

	log "Windows"
	vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
	ssh_wait 1800 || die "Windows did not answer on SSH"
	# The test's own folder only: Defender scanning 10 GB of image and Electron as they land
	# slows the VM so much that the app's 30 s read of the PC times out.
	on_vm 'Add-MpPreference -ExclusionPath C:\swiff' || true
	on_vm 'New-Item -ItemType Directory -Force C:\swiff\desktop | Out-Null; $m = [guid]::NewGuid().ToString(); Set-Content C:\swiff-marker.txt $m; $m' | tr -d '\r' > "$run/marker"
	on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-before.txt"
	on_vm '(Get-Partition -DriveLetter C).Size' | tr -d '\r\n' > "$run/c-before"
	log "Copying the installer and the image set"
	to_vm "$desktop"/{rental-cli,rental-exec,rental-worker,rental,rental-key,measured-boot,image-set,gpt,efi,pc,probe}.cjs swiff@127.0.0.1:'C:/swiff/desktop/'
	to_vm "$image_set" swiff@127.0.0.1:'C:/swiff/image'
	to_vm "$electron_dir" swiff@127.0.0.1:'C:/swiff/electron'
	on_vm 'New-Item -ItemType Directory -Force C:\swiff\vm | Out-Null'
	to_vm "$here/windows/disk-open-check.cjs" "$here/windows/key-state.cjs" swiff@127.0.0.1:'C:/swiff/vm/'
	# The app's one elevation, as the logged-on user starts it: unelevated, Start-Process -Verb RunAs.
	on_vm "Set-Content C:\\swiff\\uac-in.txt 'elevate','quit'; schtasks /create /tn swiff-uac /tr 'cmd /c C:\\node\\node.exe C:\\swiff\\desktop\\rental-cli.cjs serve --image $img < C:\\swiff\\uac-in.txt > C:\\swiff\\uac-out.txt 2>&1' /sc once /st 23:59 /it /rl LIMITED /f | Out-Null"
	local base
	base=$(pcr7 base)
	echo "PCR 7 of a clean start: $base"
	# From here each scenario says what failed in its results: a command that fails on the way
	# (a VM restarting under it) must not end the whole run.
	set +e

	if want 1; then
		scenario "1. Secure Boot already fine: what the app reads, and its one elevation"
		on_vm 'function swiff-check { $env:ELECTRON_RUN_AS_NODE = 1; & C:\swiff\electron\electron.exe C:\swiff\vm\disk-open-check.cjs | Write-Output }; swiff-check' | tr -d '\r' > "$run/disk-open.txt" || true
		expect runtime-old-name-fails "the app's runtime cannot open \\.\PhysicalDrive0, the old disk name" grep -q '^ERR \\\\.\\PhysicalDrive0 ' "$run/disk-open.txt"
		expect runtime-disk-opens "the app's runtime reads disk 0's GPT by the worker's name for it" grep -q '^OK .*GLOBALROOT.* EFI PART$' "$run/disk-open.txt"
		read_as before
		local seen
		seen="$(json "$run/read-before.json" read '.read.facts.secureBoot' || true) $(json "$run/read-before.json" read '.read.facts.db' || true) $(json "$run/read-before.json" read '.read.targets[0].id' || true)"
		expect read "Secure Boot on, the db trusts shim's CA (read from the boot log, no admin), room on C: ($seen)" test "$seen" = 'true true "shrink:C"'
		expect clean-trail "this start went straight to Windows" test "$(json "$run/read-before.json" trail '.trail.shim')" = false
		# From the logged-on user's own session, unelevated, as the app runs: Start-Process -Verb RunAs.
		on_vm "schtasks /run /tn swiff-uac | Out-Null; foreach (\$i in 1..60) { if (Select-String -Quiet elevated C:\\swiff\\uac-out.txt) { break }; Start-Sleep 2 }; Get-Content C:\\swiff\\uac-out.txt" | tr -d '\r' > "$run/uac.json"
		expect elevation "the worker started through UAC's RunAs and said hello" grep -q '"elevated":true' "$run/uac.json"

	fi
	if want 2; then
		scenario "2. Administrator declined"
		# Windows' prompt on its secure desktop, answered No (Esc) at the VM's keyboard.
		on_vm "Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name ConsentPromptBehaviorAdmin -Value 2; Remove-Item -Force -ErrorAction SilentlyContinue C:\\swiff\\uac-out.txt; schtasks /run /tn swiff-uac | Out-Null" || true
		for _ in $(seq 8); do sleep 4; monitor "sendkey esc" || true; done
		on_vm "foreach (\$i in 1..30) { if (Select-String -Quiet 'error' C:\\swiff\\uac-out.txt) { break }; Start-Sleep 2 }; Get-Content C:\\swiff\\uac-out.txt; Set-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name ConsentPromptBehaviorAdmin -Value 0" | tr -d '\r' > "$run/uac-declined.json"
		expect declined "the worker did not start: $(grep -o '"error":"[^"]*"' "$run/uac-declined.json" | head -1)" grep -q 'did not give Swiff Host administrator rights' "$run/uac-declined.json"
		read_as declined
		expect declined-nothing "nothing on the PC changed: no install record" test "$(json "$run/read-declined.json" read '.read.facts.install')" = null

	fi
	if want 3; then
		scenario "3. Not enough space"
		local free
		free=$(on_vm '(Get-Volume -DriveLetter C).SizeRemaining' | tr -d '\r\n')
		# C: keeps 30 GB free: less than Swiff OS's 24 GB and the 16 GB Windows keeps.
		on_vm "fsutil file createnew C:\\swiff-fill.bin $((free - 30 * 1024 * 1024 * 1024)) | Out-Null"
		read_as full
		expect space-none "no drive offered for Swiff OS: the screen says Free up 24 GB" test "$(json "$run/read-full.json" read '.read.targets.length')" = 0
		on_vm 'Remove-Item -Force C:\swiff-fill.bin'
		# Files added between the plan on screen and its run: the install's own check finds the room gone.
		on_vm "Set-Content C:\\swiff\\cmd-race.txt 'plan install'"
		on_vm "$cli serve --image $img --commands C:\\swiff\\cmd-race.txt" | tr -d '\r' > "$run/serve-race.json" &
		local race=$!
		for _ in $(seq 60); do grep -q '"plan"' "$run/serve-race.json" 2> /dev/null && break; sleep 5; done
		on_vm "fsutil file createnew C:\\swiff-fill.bin $((free - 30 * 1024 * 1024 * 1024)) | Out-Null; Add-Content C:\\swiff\\cmd-race.txt 'run check','quit'"
		wait "$race" || true
		on_vm 'Remove-Item -Force C:\swiff-fill.bin'
		expect space-race "the check stops before any change: $(json "$run/serve-race.json" outcome '.outcome.failed.error' || true)" grep -q 'cannot shrink by' "$run/serve-race.json"
		read_as after-space
		expect space-nothing "nothing on the PC changed: no install record" test "$(json "$run/read-after-space.json" read '.read.facts.install')" = null

	fi
	if want 4; then
		scenario "4. Removal after a partial install"
		serve partial "plan install" "run check bitlocker fast-startup room partitions"
		expect partial "the install ran up to its partitions" grep -q '"done":\["check","bitlocker","fast-startup","room","partitions"\]' "$run/serve-partial.json"
		read_as partial
		expect partial-record "the app sees an install that did not finish (Continue or Undo)" test "$(json "$run/read-partial.json" read '.read.facts.install.complete') $(json "$run/read-partial.json" read '.read.installed')" = 'false false'
		serve undo "plan uninstall" "run partitions room fast-startup bitlocker forget"
		expect undo "every step that undoes it ran" grep -q '"status":"done"' "$run/serve-undo.json"
		on_vm '(Get-Partition -DriveLetter C).Size' | tr -d '\r\n' > "$run/c-undone"
		expect undo-c "C: is its size again" cmp -s "$run/c-before" "$run/c-undone"
		expect undo-partitions "Windows' 4 partitions, and no others" test "$(on_vm 'Get-Partition -DiskNumber 0 | Measure-Object | ForEach-Object Count' | tr -d '\r\n')" = 4
		read_as undone
		expect undo-record "the install record is gone" test "$(json "$run/read-undone.json" read '.read.facts.install')" = null
		on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-undone.txt"
		expect undo-bitlocker-on "BitLocker protection is on" grep -q 'Protection On' "$run/bitlocker-undone.txt"

	fi
	if want 5; then
		scenario "5. Fresh install, key screen left waiting, then Continue boot (the wrong choice)"
		on_vm "$cli run install --image $img" | tr -d '\r' | tee "$run/install.json" | grep -E '"(outcome|error)"' || true
		expect install "every install step ran" grep -q '"outcome":{"status":"done"' "$run/install.json"
		expect mok-waits "MokManager's menu came at once and was still waiting after 150 s; then Continue boot" \
			"$python" "$here/mok-drive.py" "$run/mok-miss.log" miss 150 --loose --socket "$run/serial.sock"
		windows_back windows-after-continue
		read_as continued
		expect record-by-loader "the record keeps the boot entry by partition id and path, no Boot#### number" test "$(json "$run/read-continued.json" read '.read.facts.install.bootEntry.path')" = '"\\EFI\\swiff\\shimx64.efi"'
		# What the firmware does after Continue boot differs: shim gives up with a cold reset
		# (OVMF here), or returns and the firmware starts Windows in the same power-on (the
		# GEEKOM's AMI firmware, its boot log of 15:47). Either way the app must say what happened:
		# a fall-through is named, with the PIN warning; a reset leaves PCR 7 a clean start's.
		local trail state after
		trail="$(json "$run/read-continued.json" trail '.trail.shim') $(json "$run/read-continued.json" trail '.trail.windowsAfterShim') $(json "$run/read-continued.json" trail '.trail.loader')"
		state=$(key_state)
		after=$(pcr7 continued)
		if [ "$trail" = 'true true false' ]; then
			expect fallthrough-named "Windows started straight after shim: the app says the key didn't go in, PIN warning ($state)" test "$state" = nokey
			expect pcr7-changed "PCR 7 differs from a clean start, as the warning says" test "$after" != "$base"
		else
			expect reset-clean "the firmware reset after Continue boot: a clean start into Windows ($trail)" test "$trail" = 'false false false'
			expect reset-asks "the app asks the owner whether the code went in ($state)" test "$state" = ask
			expect pcr7-reset "PCR 7 is a clean start's: no PIN reset" test "$after" = "$base"
		fi
	fi
	if want 6; then
		scenario "6. Restart into Windows without the key (powered off at the key screen)"
		on_vm "$cli run mok --image $img" | tr -d '\r' | tee "$run/mok-1.json" | grep -E '"(outcome|error)"' || true
		expect mok-1 "BitLocker paused, a new request queued, the PC restarting" grep -q '"outcome":{"status":"done"' "$run/mok-1.json"
		expect mok-1-bitlocker "the key's restart paused BitLocker on C: first" grep -q '"id":"bitlocker","state":"done"' "$run/mok-1.json"
		expect mok-menu "MokManager's menu came, and waited" \
			"$python" "$here/mok-drive.py" "$run/mok-wait.log" wait "Perform MOK management" 300 --socket "$run/serial.sock"
		sleep 20
		vm_kill
		sleep 3
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-after-poweroff
		read_as poweroff
		expect poweroff-clean "a clean start: nothing of shim in this power-on" test "$(json "$run/read-poweroff.json" trail '.trail.shim')" = false
		expect poweroff-ask "the app asks the owner whether the code went in (state $(key_state))" test "$(key_state)" = ask
		expect pcr7-poweroff "PCR 7 is a clean start's: no PIN reset" test "$(pcr7 poweroff)" = "$base"

	fi
	if want 7; then
		scenario "7. Key confirmed (Enroll MOK, the code, Reboot)"
		on_vm "$cli run mok --image $img" | tr -d '\r' | tee "$run/mok-2.json" | grep -E '"(outcome|error)"' || true
		local code
		code=$(json "$run/mok-2.json" plan '.plan.mok.code' | tr -d '"' || true)
		expect mok-confirmed "the owner's confirmation at MokManager went through" \
			"$python" "$here/mok-drive.py" "$run/mok-confirm.log" confirm "$code" --loose --socket "$run/serial.sock"
		windows_back windows-after-mok
		read_as confirmed
		expect confirmed-clean "MokManager's Reboot: a clean start into Windows" test "$(json "$run/read-confirmed.json" trail '.trail.shim')" = false
		expect pcr7-confirmed "PCR 7 is a clean start's: Windows Hello's PIN and BitLocker unaffected" test "$(pcr7 confirmed)" = "$base"
		on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-1"
		expect files-kept-1 "C: holds its file after the install" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-1"
		expect installed "the app reads Swiff OS as installed" test "$(json "$run/read-confirmed.json" read '.read.installed' || true)" = true
		on_vm 'Get-Partition -DiskNumber 0 | Select-Object PartitionNumber, Offset, Size, GptType, Guid | ConvertTo-Json -Compress' | tr -d '\r' > "$run/partitions-installed.json"
		expect partitions "Windows sees Swiff OS's 6 partitions after its 4" \
			test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$run/partitions-installed.json")" = 10

	fi
	if want 8; then
		scenario "8. Swiff OS once"
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
		# Windows has run beside Swiff OS's ESP: it must still be a sound FAT, untouched by chkdsk.
		local esp_at esp_bytes
		read -r esp_at esp_bytes < <(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/).pop()).read; const p=r.facts.install.partitions.find(p=>p.role==="esp"); console.log(p.offset, p.bytes)' "$run/read-confirmed.json")
		qemu-img convert -O raw "json:{\"driver\":\"raw\",\"offset\":$esp_at,\"size\":$esp_bytes,\"file\":{\"driver\":\"qcow2\",\"file\":{\"driver\":\"file\",\"filename\":\"$run/disk.qcow2\"}}}" "$run/esp.raw"
		expect esp-sound "Swiff OS's ESP passes fsck.fat after Windows ran beside it" "$fsck_fat" -n "$run/esp.raw"
		expect esp-no-chkdsk "no FOUND.000 from Windows' chkdsk on it" bash -c "! MTOOLS_SKIP_CHECK=1 mdir -i '$run/esp.raw' ::/ | grep -q FOUND"
		rm -f "$run/esp.raw"
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-after-swiffos
		expect pcr7-swiffos "PCR 7 is a clean start's after Swiff OS ran" test "$(pcr7 swiffos)" = "$base"
		on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-2"
		expect files-kept-2 "C: holds its file after Swiff OS ran" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-2"

	fi
	if want 9; then
		scenario "9. Removal after a full install"
		# The key first: MokManager, which removes it, is on Swiff OS's boot partition.
		on_vm "$cli run unkey --image $img" | tr -d '\r' | tee "$run/unkey.json" | grep -E '"(outcome|error)"' || true
		expect unkey "the key's removal queued and the PC restarting" grep -q '"outcome":{"status":"done"' "$run/unkey.json"
		code=$(json "$run/unkey.json" plan '.plan.mok.code' | tr -d '"' || true)
		expect mok-removed "the owner's removal at MokManager went through" \
			"$python" "$here/mok-drive.py" "$run/mok-remove.log" remove "$code" --loose --socket "$run/serial.sock"
		windows_back windows-after-unkey
		expect pcr7-unkey "PCR 7 is a clean start's after the key's removal" test "$(pcr7 unkey)" = "$base"
		on_vm "$cli run uninstall --image $img" | tr -d '\r' | tee "$run/uninstall.json" | grep -E '"(outcome|error)"' || true
		expect uninstall "every uninstall step ran" grep -q '"outcome":{"status":"done"' "$run/uninstall.json"
		# Windows starts as before, from the firmware's own entry, without its recovery key.
		on_vm 'Restart-Computer -Force' || true
		sleep 30
		windows_back windows-after-uninstall
		on_vm '(Get-Partition -DriveLetter C).Size' | tr -d '\r\n' > "$run/c-after"
		expect c-grown "C: is its size again: $(cat "$run/c-after") bytes" cmp -s "$run/c-before" "$run/c-after"
		expect partitions-gone "Windows' 4 partitions, and no others" test "$(on_vm 'Get-Partition -DiskNumber 0 | Measure-Object | ForEach-Object Count' | tr -d '\r\n')" = 4
		read_as after
		expect forgotten "the app reads Swiff OS as not installed" test "$(json "$run/read-after.json" read '.read.facts.install' || true)" = null
		on_vm "Get-Content C:\\swiff-marker.txt" | tr -d '\r\n' > "$run/marker-3"
		expect files-kept-3 "C: holds its file after the uninstall" cmp -s <(tr -d '\n' < "$run/marker") "$run/marker-3"
		on_vm 'manage-bde -status C:' | tr -d '\r' > "$run/bitlocker-after.txt"
		expect bitlocker-on "BitLocker protects C: again" grep -q 'Protection On' "$run/bitlocker-after.txt"
		on_vm 'Stop-Computer -Force' || true
		vm_wait_off 300 || vm_kill
		"$run/boot-vars" show "$run/vars.fd" | tee "$run/vars-after.txt"
		expect no-boot-entry "the firmware has no Swiff OS entry" bash -c "! grep -q 'Swiff OS' '$run/vars-after.txt'"
		expect key-removed "MokList no longer holds Swiff's key" bash -c "! grep -q '$cert_hex' '$run/vars-after.txt'"
		expect no-wait-left "no MokTimeout left behind" grep -q '^MokTimeout: none$' "$run/vars-after.txt"

	fi
	if want 10; then
		scenario "10. Reinstall after removal"
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-before-reinstall
		on_vm "$cli run install --image $img" | tr -d '\r' | tee "$run/reinstall.json" | grep -E '"(outcome|error)"' || true
		expect reinstall "every install step ran again" grep -q '"outcome":{"status":"done"' "$run/reinstall.json"
		code=$(json "$run/reinstall.json" plan '.plan.mok.code' | tr -d '"' || true)
		expect reinstall-mok "the key confirmed again at MokManager" \
			"$python" "$here/mok-drive.py" "$run/mok-reconfirm.log" confirm "$code" --loose --socket "$run/serial.sock"
		windows_back windows-after-reinstall
		expect pcr7-reinstall "PCR 7 is a clean start's" test "$(pcr7 reinstall)" = "$base"
		on_vm "$cli run once --image $img" | tr -d '\r' > "$run/once-2.json"
		expect swiffos-again "Swiff OS's self-test ran again after the reinstall" \
			"$python" "$here/mok-drive.py" "$run/swiffos-2.log" wait "SWIFF-SELFTEST DONE" 900 --socket "$run/serial.sock"
		vm_wait_off 300 || vm_kill

	fi
	if want 11; then
		scenario "11. Second app instance"
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-before-instances
		if [ -n "${SWIFF_HOST_EXE:-}" ] && [ -s "$SWIFF_HOST_EXE" ]; then
			to_vm "$SWIFF_HOST_EXE" swiff@127.0.0.1:'C:/swiff/SwiffHost.exe'
			# The portable exe unpacks the app and starts it; the second start must hand over to the
			# first and quit. Counted as the app's main processes (Electron's without --type=), which an
			# SSH session sees, unlike their windows.
			local mains='@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "*Swiff Host*.exe" -and $_.CommandLine -notmatch "--type=" }).Count'
			on_vm "schtasks /create /tn swiff-app /tr 'C:\\swiff\\SwiffHost.exe' /sc once /st 23:59 /it /rl LIMITED /f | Out-Null; schtasks /run /tn swiff-app | Out-Null; Start-Sleep 120; $mains" | tr -d '\r' > "$run/instances-1.txt"
			on_vm "schtasks /run /tn swiff-app | Out-Null; Start-Sleep 90; $mains; Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -like '*Swiff*' } | ForEach-Object { '{0} {1}' -f \$_.ProcessId, \$_.CommandLine }" | tr -d '\r' > "$run/instances-2.txt"
			expect app-started "the app started: $(head -1 "$run/instances-1.txt") main process" test "$(head -1 "$run/instances-1.txt")" = 1
			expect one-instance "a second start left one app running: $(head -1 "$run/instances-2.txt") main process" test "$(head -1 "$run/instances-2.txt")" = 1
		else
			result SKIP one-instance "no \$SWIFF_HOST_EXE given"
		fi

	fi
	if want 12; then
		# Before any install: run it from a fresh copy (SWIFF_SCENARIOS="12"), or after 9 without 10.
		scenario "12. Secure Boot off"
		on_vm 'manage-bde -protectors -disable C: -RebootCount 2 | Out-Null; Stop-Computer -Force' || true
		vm_wait_off 300 || vm_kill
		"$python" "$here/boot-vars.py" secure-boot "$run/vars.fd" off
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-secure-boot-off
		read_as sb-off
		expect sb-off-read "the app reads Secure Boot off: the BIOS to-do, Turn on Secure Boot" test "$(json "$run/read-sb-off.json" read '.read.facts.secureBoot')" = false
		serve sb-off "plan install" "run check"
		expect sb-off-check "the install's own check stops on it too, before any change" grep -q 'Secure Boot is off' "$run/serve-sb-off.json"
		on_vm 'Stop-Computer -Force' || true
		vm_wait_off 300 || vm_kill
		"$python" "$here/boot-vars.py" secure-boot "$run/vars.fd" on
		vm_start "$run/disk.qcow2" "$run/vars.fd" "$run/tpm"
		windows_back windows-secure-boot-on
		read_as sb-on
		expect sb-on-read "turned back on, the app reads it on" test "$(json "$run/read-sb-on.json" read '.read.facts.secureBoot')" = true
		on_vm 'Stop-Computer -Force' || true
		vm_wait_off 300 || vm_kill

	fi
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
