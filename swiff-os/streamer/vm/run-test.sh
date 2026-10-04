#!/bin/sh
# The streamer's VM test: builds a small test image (mkosi.conf), boots it in
# QEMU and plays a renter session through it end to end, with the real server
# and a real browser on this host (harness.mjs) and the streamer, its capture
# and its virtual devices inside the VM (mkosi.extra/usr/libexec/swiff/streamer-vmtest).
#
#   swiff-os/streamer/vm/run-test.sh             build the image, then run the test
#   swiff-os/streamer/vm/run-test.sh --no-build  run it on the last build
#   swiff-os/streamer/vm/run-test.sh --build-only  build the image, start no VM
#
# It touches nothing of this PC but its own build directory: no disks, boot
# entries or firmware variables. mkosi 20 builds as root, so the build uses
# sudo; so does QEMU when this user cannot open /dev/kvm, and it drops back to
# this user (-runas) before the VM starts. The VM gets 2 GiB and 2 vCPUs, and
# the test waits while another VM runs or the PC is short of memory.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
streamer=$(dirname "$here")
repo=$(cd "$streamer/../.." && pwd)
build=${SWIFF_STREAMER_BUILD_DIR:-$HOME/.cache/swiff-os-streamer}
browsers=${PLAYWRIGHT_BROWSERS_PATH:-$build/playwright}
mkdir -p "$build"

no_build=0
build_only=0
case "${1:-}" in
--no-build) no_build=1 ;;
--build-only) build_only=1 ;;
esac

# One VM at a time on this PC, and only with memory to spare.
wait_for_room() {
    tries=0
    while pgrep -x 'qemu-system-.*' >/dev/null 2>&1 ||
        [ "$(free -m | awk '/^Mem:/ {print $7}')" -lt 4096 ]; do
        tries=$((tries + 1))
        if [ "$tries" -gt 20 ]; then
            echo "run-test: no room for a VM after 60 minutes (another VM, or under 4 GB free)" >&2
            exit 1
        fi
        echo "run-test: another VM is running or memory is short; checking again in 3 minutes"
        sleep 180
    done
}

echo "== building the streamer, the server and the web app"
(cd "$repo" && npm run build -w @swiff/os-streamer && npm run build -w @swiff/server && npm run build -w @swiff/web) >/dev/null

if [ "$no_build" = 0 ] || [ ! -e "$build/out/swiff-streamer-vmtest.raw" ]; then
    echo "== staging the streamer for the image"
    stage="$build/out/stage"
    rm -rf "$stage"
    lib="$stage/usr/lib/swiff/streamer"
    mkdir -p "$lib/dist" "$lib/helpers" "$stage/usr/local/bin" "$stage/usr/lib/sysusers.d" \
        "$stage/usr/lib/tmpfiles.d" "$stage/usr/lib/udev/rules.d" "$stage/usr/libexec/swiff" \
        "$stage/usr/lib/systemd/user"
    cp "$streamer/dist/swiff-streamer.mjs" "$lib/dist/"
    cp "$streamer/helpers/swiff-gst.py" "$streamer/helpers/swiff-uinput.py" "$lib/helpers/"
    # This host's Node 22 runs in the VM too: same Ubuntu release, same libraries.
    cp "$(command -v node)" "$stage/usr/local/bin/node"
    cp "$streamer/system/swiff-streamer.sysusers" "$stage/usr/lib/sysusers.d/swiff-streamer.conf"
    cp "$streamer/system/swiff-streamer.tmpfiles" "$stage/usr/lib/tmpfiles.d/swiff-streamer.conf"
    cp "$streamer/system/70-swiff-streamer.rules" "$stage/usr/lib/udev/rules.d/"
    cp "$streamer/system/swiff-pipewire-grant" "$stage/usr/libexec/swiff/"
    cp "$streamer/system/swiff-pipewire-grant.service" "$stage/usr/lib/systemd/user/"

    echo "== building the test image (the first build downloads about 1 GB)"
    sudo mkosi -C "$here" --output-dir "$build/out" --cache-dir "$build/cache" \
        --force build
fi
[ "$build_only" = 1 ] && exit 0

if [ ! -d "$browsers/chromium_headless_shell-"* ] 2>/dev/null; then
    echo "== fetching Playwright's Chromium into $browsers"
    (cd "$repo" && PLAYWRIGHT_BROWSERS_PATH="$browsers" npx playwright install chromium-headless-shell) >/dev/null
fi

wait_for_room

server_port=$((20000 + $(od -An -N2 -tu2 /dev/urandom) % 20000))
harness_port=$((server_port + 1))
results="$build/results.json"

echo "== starting the platform and the renter (harness)"
PLAYWRIGHT_BROWSERS_PATH="$browsers" node "$here/harness.mjs" \
    --server-port "$server_port" --harness-port "$harness_port" --out "$results" &
harness=$!

vars="$build/OVMF_VARS.fd"
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$vars"
kvm_sudo=""
[ -r /dev/kvm ] && [ -w /dev/kvm ] || kvm_sudo="sudo"

echo "== booting the VM (2 GiB, 2 vCPUs); its console is in $build/console.log"
set +e
timeout 600 $kvm_sudo qemu-system-x86_64 \
    ${kvm_sudo:+-runas "$(id -un)"} \
    -machine q35,accel=kvm -cpu host -smp 2 -m 2048 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file="$vars" \
    -drive file="$build/out/swiff-streamer-vmtest.raw",format=raw,if=virtio,snapshot=on \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -device virtio-rng-pci \
    -smbios type=11,value=io.systemd.credential:swifftest.harness="$harness_port" \
    -display none -serial file:"$build/console.log" -monitor none
qemu=$?
set -e
echo "== the VM is off (qemu exit $qemu)"

wait "$harness"
status=$?
echo "== results in $results"
exit "$status"
