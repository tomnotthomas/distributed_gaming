#!/usr/bin/env bash
# Lanterel OS LAN test: a PC in rental mode, in its owner's home network,
# reaches the internet and nothing of the home network.
#
# Boots the self-test build (vm/build-image.sh selftest) in QEMU/KVM under
# OVMF with Secure Boot and a software TPM, in a home network of its own: a
# bridge in a user and network namespace, the VM on it through a tap device,
# and (vm/lan-fixture.py):
#
#   the router    192.168.77.1, fe80::1, 2001:db8:77::1. dnsmasq hands out
#                 the addresses (DHCP, router advertisements) and answers DNS;
#                 admin pages on 80 and 443, also on its public address
#                 203.0.113.7, and on 80 at 100.64.0.1 and 192.0.0.2 (a CGNAT
#                 and a DS-Lite WAN address).
#   a device      192.168.77.50, fe80::50, 2001:db8:77::50, in a network
#                 namespace of its own: a page, and answers to mDNS, SSDP,
#                 LLMNR and NetBIOS.
#   the internet  198.51.100.10 and 2001:db8:ffff::10 behind the router
#                 (TEST-NET, which the firewall treats as the internet): a page
#                 and a UDP echo, as a STUN server answers. The stream's STUN
#                 servers resolve to 198.51.100.30, which tells the VM it is at
#                 the router's public address.
#
#   boot 1  the in-image test (selftest-lan lan) probes all of it, as the
#           renter and as root, with the firewall and then without it as the
#           control; meanwhile the device connects to the VM. The internet and
#           DNS answer, and nothing of the home network does, with the firewall.
#   boot 2  the firewall's ruleset fails to load (swiff.selftest.firewall=broken
#           on the kernel command line, through an SMBIOS string systemd-stub
#           takes): systemd-networkd never starts, initrd included, no network
#           comes up, and the router never hears from the VM.
#
# This script adds what needs the network's view: the router answered the VM's
# DHCP renewal, the device could not connect to the VM with the firewall and
# could without it, and the router heard nothing from the VM in boot 2.
#
# Usage: vm/lan-test.sh [--no-build|--rebuild]
#
# The image is built by vm/build-image.sh only when what goes into it changed;
# --rebuild builds it anyway, and --no-build takes the newest stored build.
# Build output, caches and the VM's files go to $SWIFF_OS_BUILD_DIR (default
# ~/.cache/swiff-os), the run in lan-vm/.
#
# Needs: sudo (mkosi 20 builds as root), qemu-system-x86_64, qemu-img, swtpm,
# OVMF (/usr/share/OVMF), a /dev/kvm this user can open, mkfs.ext4, unshare
# (user and network namespaces), python3 and dnsmasq (DNSMASQ=path, else on
# PATH). The VM gets 2 GiB of RAM and 4 vCPUs ($SWIFF_VM_CPUS), and starts
# through vm/vm-run.py: it waits for room among this PC's test VMs, and a boot
# is stopped when it outlasts $BOOT_TIMEOUT (600 s) or its console is silent
# for $BOOT_STALL seconds (300). Nothing here touches the host's disks, boot
# entries, UEFI variables or network.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/$(basename "$0")
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
run=$build_dir/lan-vm

ovmf_code=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
ovmf_vars=/usr/share/OVMF/OVMF_VARS_4M.fd
boot_timeout=${BOOT_TIMEOUT:-600}
boot_stall=${BOOT_STALL:-300}
cpus=${SWIFF_VM_CPUS:-4}
# The VM's network card, which the router gives 192.168.77.10.
mac=52:54:00:12:77:10
broken=io.systemd.stub.kernel-cmdline-extra=swiff.selftest.firewall=broken

# Prints a section heading.
log() { printf '\n== %s\n' "$*"; }
# Prints an error and exits.
die() {
	echo "lan-test: $*" >&2
	exit 1
}

if [ "${SWIFF_LAN_INSIDE:-}" != 1 ]; then
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

	for tool in qemu-system-x86_64 qemu-img swtpm mkosi mkfs.ext4 unshare nsenter python3; do
		command -v "$tool" > /dev/null || [ -x "/usr/sbin/$tool" ] || die "$tool not found"
	done
	[ -w /dev/kvm ] || die "/dev/kvm is not usable by $(id -un)"
	[ -r "$ovmf_code" ] && [ -r "$ovmf_vars" ] || die "OVMF Secure Boot firmware not found in /usr/share/OVMF"
	DNSMASQ=${DNSMASQ:-$(command -v dnsmasq || true)}
	[ -x "$DNSMASQ" ] || die "dnsmasq not found: install dnsmasq-base, or set DNSMASQ"
	export DNSMASQ

	mkdir -p "$run"
	# One run at a time; the descriptor is inherited into the namespace.
	exec 9> "$run/lock"
	flock -n 9 || die "another lan-test.sh is running"

	if [ "$build" = 0 ]; then
		disk_src=$(ls -t "$build_dir"/images/selftest-*.raw 2> /dev/null | head -n1)
	else
		log "The test image (vm/build-image.sh selftest)"
		rebuild=()
		[ "$build" = 2 ] && rebuild=(--rebuild)
		disk_src=$("$here/build-image.sh" selftest "${rebuild[@]}").raw
	fi
	[ -e "$disk_src" ] || die "no self-test image built (run without --no-build)"

	log "Preparing the VM in $run"
	rm -rf "$run/tpm" "$run/fixtures" "$run"/*.log "$run"/*.qcow2 "$run"/*.fd "$run"/*.img "$run"/*.leases
	qemu-img create -q -f qcow2 -b "$disk_src" -F raw "$run/disk.qcow2"
	cp "$ovmf_vars" "$run/vars.fd"
	mkdir -p "$run/tpm"
	echo "== running the test in a network namespace of its own"
	exec env SWIFF_LAN_INSIDE=1 unshare --user --map-root-user --net "$script"
fi

# --- The home network ------------------------------------------------------------
pids=()
trap 'kill "${pids[@]}" 2> /dev/null || true' EXIT

ip link set lo up
ip addr add 198.51.100.10/32 dev lo
ip addr add 198.51.100.30/32 dev lo
ip addr add 203.0.113.7/32 dev lo
ip addr add 100.64.0.1/32 dev lo
ip addr add 192.0.0.2/32 dev lo
ip addr add 2001:db8:ffff::10/128 dev lo
# The router's side: its only link-local address is fe80::1, the source of
# its router advertisements and so the VM's IPv6 gateway.
ip link add br0 type bridge mcast_snooping 0
ip link set br0 addrgenmode none
ip addr add 192.168.77.1/24 dev br0
ip addr add 2001:db8:77::1/64 dev br0 nodad
ip addr add fe80::1/64 dev br0 nodad
ip tuntap add dev tap0 mode tap
ip link set tap0 master br0 up
ip link set br0 up

unshare --net sleep infinity &
device=$!
pids+=("$device")
for _ in $(seq 50); do [ "$(readlink "/proc/$device/ns/net")" != "$(readlink /proc/self/ns/net)" ] && break; sleep 0.1; done
ip link add dev0 type veth peer name dev1
ip link set dev1 netns "$device"
ip link set dev0 master br0 up
nsenter -t "$device" -n sh -c '
	ip link set lo up
	ip link set dev1 addrgenmode none
	ip addr add 192.168.77.50/24 dev dev1
	ip addr add 2001:db8:77::50/64 dev dev1 nodad
	ip addr add fe80::50/64 dev dev1 nodad
	ip link set dev1 up'

# --no-daemon: dnsmasq stays this user, which a user namespace cannot change.
"$DNSMASQ" --no-daemon --conf-file=/dev/null \
	--no-resolv --no-hosts --interface=br0 --bind-interfaces \
	--dhcp-range=192.168.77.100,192.168.77.150,255.255.255.0,1h \
	--dhcp-host="$mac,192.168.77.10" --dhcp-leasefile="$run/dnsmasq.leases" \
	--enable-ra --dhcp-range=::,constructor:br0,ra-only,64,1h \
	--address=/internet.lanterel.test/198.51.100.10 --address=/internet.lanterel.test/2001:db8:ffff::10 \
	--address=/stun.l.google.com/stun1.l.google.com/stun.cloudflare.com/198.51.100.30 \
	--log-dhcp --log-queries --log-facility="$run/dnsmasq.log" > /dev/null 2>&1 &
pids+=($!)
python3 "$here/lan-fixture.py" router > "$run/router.log" 2>&1 &
pids+=($!)
nsenter -t "$device" -n python3 "$here/lan-fixture.py" device dev1 > "$run/device.log" 2>&1 &
pids+=($!)
for _ in $(seq 50); do
	grep -q 'router ready' "$run/router.log" && grep -q 'device ready' "$run/device.log" && break
	sleep 0.1
done
grep -q 'router ready' "$run/router.log" || die "the router's servers did not start: $(cat "$run/router.log")"
grep -q 'device ready' "$run/device.log" || die "the device's servers did not start: $(cat "$run/device.log")"

# Watches a boot's serial log for selftest-lan's "LAN-INBOUND <round> <ipv4>
# <ipv6> <port>" lines and connects to each address from the device, once per
# round, into inbound.log.
drive_inbound() { # serial-log
	local serial=$1 seen=0 lines line round v4 v6 port addr
	while :; do
		mapfile -t lines < <(sed -n 's/^.*SWIFF-SELFTEST LAN-INBOUND \(.*\)$/\1/p' "$serial" 2> /dev/null | tr -d '\r')
		while [ "$seen" -lt "${#lines[@]}" ]; do
			read -r round v4 v6 port <<< "${lines[$seen]}"
			for addr in "$v4" "$v6"; do
				echo "$round $addr $(nsenter -t "$device" -n python3 "$here/lan-fixture.py" probe "$addr" "$port")" >> "$run/inbound.log"
			done
			seen=$((seen + 1))
		done
		sleep 0.5
	done
}

# Boots the VM once with swtpm and waits for the in-image test to finish;
# dies if it does not. More arguments go to QEMU.
boot_vm() { # boot number, phase, QEMU arguments...
	local n=$1 serial=$run/serial-$1.log rc=0
	shift
	log "Boot $n ($1)"
	rm -rf "$run/fixtures" "$run/fixtures.img"
	mkdir "$run/fixtures"
	echo "$1" > "$run/fixtures/phase"
	mkfs.ext4 -q -L SWIFFFIX -d "$run/fixtures" "$run/fixtures.img" 16M
	shift
	swtpm socket --tpm2 --terminate \
		--tpmstate dir="$run/tpm" \
		--ctrl type=unixio,path="$run/tpm/sock" \
		--log file="$run/swtpm-$n.log" &
	local swtpm_pid=$!
	for _ in $(seq 50); do [ -S "$run/tpm/sock" ] && break; sleep 0.1; done
	drive_inbound "$serial" &
	local inbound_pid=$!

	"$here/vm-run.py" --name "lantest-boot$n" --timeout "$boot_timeout" \
		--stall "$boot_stall" --progress "$serial" -- qemu-system-x86_64 \
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
		-netdev tap,id=n0,ifname=tap0,script=no,downscript=no \
		-device virtio-net-pci,netdev=n0,mac="$mac" \
		-display none -vga none -monitor none \
		-serial "file:$serial" "$@" || rc=$?
	kill "$swtpm_pid" "$inbound_pid" 2> /dev/null || true
	wait "$swtpm_pid" "$inbound_pid" 2> /dev/null || true
	grep -q 'SWIFF-SELFTEST DONE' "$serial" || {
		tail -n 40 "$serial" >&2
		die "boot $n did not finish the test (serial log: $serial)"
	}
	[ "$rc" = 0 ] || die "boot $n: the VM did not power off cleanly (vm-run.py status $rc; serial log: $serial)"
}

boot_vm 1 lan
# What the router logged from here on is boot 2's.
seen_before=$(wc -l < "$run/dnsmasq.log")
boot_vm 2 lan-firewall-broken -smbios "type=11,value=$broken"

# --- Verdict -------------------------------------------------------------------
log "Results"
fail=0
# Prints one row of the results table and records a failure.
result() { # PASS|FAIL name detail
	printf '%-4s  %-34s %s\n' "$1" "$2" "$3"
	[ "$1" = PASS ] || fail=1
}

for n in 1 2; do
	rows=$(sed -n 's/^.*SWIFF-SELFTEST \(PASS\|FAIL\) /\1 /p' "$run/serial-$n.log" | tr -d '\r')
	[ -n "$rows" ] || result FAIL "boot$n/results" "the in-image test reported nothing"
	while read -r status name detail; do
		result "$status" "boot$n/$name" "$detail"
	done <<< "$rows"
done

acks=$(head -n "$seen_before" "$run/dnsmasq.log" | grep -c "DHCPACK(br0) 192.168.77.10 $mac" || true)
if [ "$acks" -ge 2 ]; then
	result PASS boot1/dhcp-renewal-answered "the router acknowledged the VM's lease $acks times (renewal included)"
else
	result FAIL boot1/dhcp-renewal-answered "the router acknowledged the VM's lease $acks times"
fi
# The device's connections to the VM: dropped with the firewall, answered without.
for round in firewall control; do
	got=$(awk -v r="$round" '$1 == r { print $2 " " $3 }' "$run/inbound.log" 2> /dev/null | paste -sd, -)
	want=timeout
	name=boot1/device-cannot-connect
	if [ "$round" = control ]; then
		want=connected
		name=boot1/control-device-connects
	fi
	if [ "$(awk -v r="$round" '$1 == r' "$run/inbound.log" 2> /dev/null | wc -l)" = 2 ] &&
		[ -z "$(awk -v r="$round" -v w="$want" '$1 == r && $3 != w' "$run/inbound.log")" ]; then
		result PASS "$name" "from 192.168.77.50: ${got}"
	else
		result FAIL "$name" "from 192.168.77.50: ${got:-no connection tried} (want $want)"
	fi
done
started=$(grep -ac 'Started .*systemd-networkd.service' "$run/serial-2.log" || true)
if [ "$started" = 0 ]; then
	result PASS boot2/networkd-never-started "systemd-networkd started neither in the initrd nor after it"
else
	result FAIL boot2/networkd-never-started "systemd-networkd started $started times"
fi
heard=$(tail -n +"$((seen_before + 1))" "$run/dnsmasq.log" | grep -c "$mac" || true)
if [ "$heard" = 0 ]; then
	result PASS boot2/router-heard-nothing "no DHCP from the VM while its firewall had not loaded"
else
	result FAIL boot2/router-heard-nothing "the router logged the VM's card $heard times"
fi

echo
if [ "$fail" = 0 ]; then
	echo "Lanterel OS LAN test: PASS"
else
	echo "Lanterel OS LAN test: FAIL (logs in $run)"
	exit 1
fi
