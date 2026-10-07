# Sourced by run-test.sh: how it boots the VM and judges the run.

# boot_vm CONSOLE COMMAND...: runs the VM's QEMU command through
# swiff-os/vm/vm-run.py, which waits for room among this PC's test VMs, for at
# most $SWIFF_VM_TIMEOUT seconds (600) and while its console (the file CONSOLE)
# is not silent for 300. Its status is QEMU's, 124 on the timeout, 125 on the
# silence.
boot_vm() {
    console=$1
    shift
    "${here:-$(dirname "$0")}/../../vm/vm-run.py" --name streamer --timeout "${SWIFF_VM_TIMEOUT:-600}" \
        --stall 300 --progress "$console" -- "$@"
}

# run_status HARNESS_PID QEMU_STATUS: waits for the harness. Its status is the
# harness's, or QEMU's when the harness passed: a VM that did not power off on
# its own (timeout) fails the run too.
run_status() {
    status=0
    wait "$1" || status=$?
    if [ "$status" = 0 ] && [ "$2" != 0 ]; then
        status=$2
    fi
    return "$status"
}
