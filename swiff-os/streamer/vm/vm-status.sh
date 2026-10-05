# Sourced by run-test.sh: how it boots the VM and judges the run.

# boot_vm COMMAND...: runs the VM's QEMU command for at most
# $SWIFF_VM_TIMEOUT seconds (600). Its status is QEMU's, 124 on the timeout.
boot_vm() {
    timeout "${SWIFF_VM_TIMEOUT:-600}" "$@"
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
