#!/usr/bin/env bash
# Rental mode's one confirmation at the PC, tested in a VM: Swiff's key
# enrolled as a MOK through a Linux distribution's Microsoft-signed shim.
#
# The install queues Swiff's key (rental.cjs, the "mok" step) and restarts;
# shim then shows MokManager, where the owner types the code the host app
# shows. This boots OVMF with Microsoft's Secure Boot keys and an ESP holding
# Ubuntu's signed shim and MokManager, queues a throwaway certificate with the
# app's own MokNew and MokAuth (apply-plan.cjs mok), and plays the owner over
# the serial console (mok-drive.py):
#
#   1. a miss: MokManager opens its menu at once and waits (MokTimeout -1,
#      queued with the request): still there after a minute. Then the wrong
#      choice, Continue boot: the request is gone and nothing is enrolled, so
#      the owner confirms again
#   2. again with a new code, as the host app does after a miss: Enroll MOK,
#      Continue, Yes, the code, Reboot. MokList then holds the certificate
#
# Usage: vm/mok-enroll-test.sh
#
# Needs qemu-system-x86_64, OVMF's Secure Boot build with Microsoft's keys,
# openssl, node, apt-get (to download shim-signed, or set SHIM_DIR to a folder
# with shimx64.efi.signed.latest and mmx64.efi), a Python with virt-firmware
# ($VIRT_FW_PYTHON), and sudo for QEMU when /dev/kvm is not writable. Nothing
# here touches the host's UEFI variables: they are a copy of OVMF's template.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
run=${SWIFF_MOK_VM_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os/mok-vm}
python=${VIRT_FW_PYTHON:-python3}
ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.ms.fd

# Prints a section heading.
log() { printf '\n== %s\n' "$*"; }
# Prints an error and exits.
die() {
	echo "mok-enroll-test: $*" >&2
	exit 1
}

for tool in node openssl qemu-system-x86_64; do
	command -v "$tool" > /dev/null || die "$tool not found"
done
"$python" -c 'import virt.firmware' 2> /dev/null || die "$python has no virt-firmware (set VIRT_FW_PYTHON)"
[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware with Microsoft's keys not found in /usr/share/OVMF"
qemu=(qemu-system-x86_64)
if [ ! -w /dev/kvm ]; then
	sudo -n true 2> /dev/null || die "needs a writable /dev/kvm, or sudo without a password for QEMU"
	qemu=(sudo -n qemu-system-x86_64 -runas "$(id -un)")
fi
# This VM takes 512 MiB, among this PC's other test VMs (swiff-os/vm/vm-run.py).
qemu=("$here/../../swiff-os/vm/vm-run.py" --name mok --timeout 600 -- "${qemu[@]}")

mkdir -p "$run"
exec 9> "$run/lock"
flock -n 9 || die "another mok-enroll-test.sh is running"
export BOOT_VARS=$run/boot-vars
printf '#!/bin/sh\nexec %q %q "$@"\n' "$python" "$here/boot-vars.py" > "$BOOT_VARS"
chmod +x "$BOOT_VARS"
rm -rf "$run/esp" "$run"/*.log "$run"/*.fd "$run"/*.bin "$run"/*.cer "$run"/*.pem

# --- an ESP with a distribution's signed shim ------------------------------------------
shim=${SHIM_DIR:-}
if [ -z "$shim" ]; then
	log "Ubuntu's shim-signed"
	rm -rf "$run/deb" && mkdir -p "$run/deb"
	(cd "$run/deb" && apt-get download shim-signed > /dev/null && dpkg-deb -x shim-signed_*.deb .)
	ls "$run"/deb/shim-signed_*.deb
	shim=$run/deb/usr/lib/shim
fi
mkdir -p "$run/esp/EFI/BOOT"
cp "$shim/shimx64.efi.signed.latest" "$run/esp/EFI/BOOT/BOOTX64.EFI"
cp "$shim/mmx64.efi" "$run/esp/EFI/BOOT/mmx64.efi"

# Swiff's certificate's stand-in.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$run/key.pem" -out "$run/cert.pem" \
	-days 1 -subj "/CN=Lanterel OS test MOK" 2> /dev/null
openssl x509 -in "$run/cert.pem" -outform DER -out "$run/swiffos-key.cer"
cp "$ovmf_vars" "$run/vars.fd"

# Boots the VM and plays the owner: mok-drive.py MODE [CODE].
boot_vm() { # log mode [code]
	"$python" "$here/mok-drive.py" "$run/$1" "${@:2}" -- "${qemu[@]}" \
		-machine q35,smm=on,accel=kvm -cpu host -smp 1 -m 512 \
		-global driver=cfi.pflash01,property=secure,value=on \
		-global ICH9-LPC.disable_s3=1 \
		-drive if=pflash,format=raw,unit=0,readonly=on,file="$ovmf_code" \
		-drive if=pflash,format=raw,unit=1,file="$run/vars.fd" \
		-drive file=fat:"$run/esp",format=raw,snapshot=on \
		-net none -display none -vga none -monitor none
}

# A fresh code, as the install plan makes one.
code() { node -e 'console.log(require(process.argv[1]).mokCode())' "$here/../rental.cjs"; }

# --- 1. queued, then missed -------------------------------------------------------------
log "Queue Lanterel's key, then miss the screen"
first=$(code)
node "$here/apply-plan.cjs" mok "$run/vars.fd" "$run/swiffos-key.cer" "$first"
"$BOOT_VARS" show "$run/vars.fd" | tee "$run/vars-queued.log"
boot_vm serial-miss.log miss 60
"$BOOT_VARS" show "$run/vars.fd" | tee "$run/vars-missed.log"

# --- 2. queued again, confirmed ---------------------------------------------------------
log "Queue it again with a new code, and confirm it"
second=$(code)
node "$here/apply-plan.cjs" mok "$run/vars.fd" "$run/swiffos-key.cer" "$second"
boot_vm serial-confirm.log confirm "$second"
"$BOOT_VARS" show "$run/vars.fd" | tee "$run/vars-confirmed.log"

# --- results ----------------------------------------------------------------------------
log "Results"
failed=0
expect() { # name detail command...
	local name=$1 detail=$2
	shift 2
	if "$@"; then echo "  ok    $name: $detail"; else
		echo "  FAIL  $name: $detail"
		failed=1
	fi
}
der=$(od -An -v -tx1 "$run/swiffos-key.cer" | tr -d ' \n')
expect queued "$(sed -n 3p "$run/vars-queued.log")" grep -q "^MOK request: MokNew .* MokAuth 32 bytes$" "$run/vars-queued.log"
expect queued-waits "$(sed -n 4p "$run/vars-queued.log")" grep -q "^MokTimeout: -1$" "$run/vars-queued.log"
expect wait-used-up "after MokManager: $(sed -n 4p "$run/vars-missed.log")" grep -q "^MokTimeout: none$" "$run/vars-missed.log"
expect miss-clears "after a miss: $(sed -n 3p "$run/vars-missed.log")" grep -q "^MOK request: none$" "$run/vars-missed.log"
expect miss-enrols-nothing "after a miss: MokList $(sed -n 5p "$run/vars-missed.log" | cut -c10-30)" \
	grep -q "^MokList: none$" "$run/vars-missed.log"
expect confirm-clears "after confirming: $(sed -n 3p "$run/vars-confirmed.log")" \
	grep -q "^MOK request: none$" "$run/vars-confirmed.log"
expect confirm-enrols "MokList holds Lanterel's certificate" grep -q "^MokList: .*$der" "$run/vars-confirmed.log"

if [ "$failed" = 0 ]; then
	echo "MOK enrolment VM test: PASS"
else
	echo "MOK enrolment VM test: FAIL (logs in $run)"
	exit 1
fi
