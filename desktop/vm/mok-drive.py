#!/usr/bin/env python3
"""Boots a VM into shim's MokManager and plays the owner at its blue screen.

Used by vm/mok-enroll-test.sh. OVMF mirrors its console on the serial port,
so this reads MokManager's screens there and types on it, as the owner would
on the PC's keyboard, following the steps the host app shows (MOK_SCREENS in
src/rental.ts):

  mok-drive.py LOG miss -- QEMU...           press nothing: the 10-second wait runs out
  mok-drive.py LOG confirm CODE -- QEMU...   Enroll MOK, Continue, Yes, the code, Reboot

QEMU... is the full QEMU command line, without a serial option. Exits nonzero
when a screen the owner is told about does not come.
"""

import os
import re
import select
import subprocess
import sys
import time

ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
DOWN = b"\x1b[B"
ENTER = b"\r"


class Vm:
    def __init__(self, qemu, log):
        self.proc = subprocess.Popen(
            qemu + ["-serial", "stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE
        )
        self.log = open(log, "wb")
        self.seen = b""

    def expect(self, text, timeout):
        """Waits until `text` is on the screen since the last expect, which may already have shown it."""
        want = text.encode()
        end = time.monotonic() + timeout
        while True:
            plain = ANSI.sub(b"", self.seen)
            at = plain.find(want)
            if at >= 0:
                self.seen = plain[at + len(want) :]
                return
            if time.monotonic() >= end:
                break
            ready, _, _ = select.select([self.proc.stdout], [], [], 0.5)
            if ready:
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.log.write(chunk)
                self.log.flush()
                self.seen += chunk
        sys.exit(f"mok-drive: no {text!r} on the screen within {timeout} s")

    def press(self, *keys):
        """Types keys one at a time, as a person would, once the screen has settled."""
        time.sleep(1)
        for key in keys:
            self.proc.stdin.write(key)
            self.proc.stdin.flush()
            time.sleep(0.3)

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def main(log, mode, *rest):
    code = rest[0] if mode == "confirm" else None
    qemu = list(rest[rest.index("--") + 1 :])
    vm = Vm(qemu, log)
    try:
        vm.expect("Press any key to perform MOK management", 120)
        if mode == "miss":
            # MokManager gives up after 10 seconds and shim goes on to its next
            # stage, which this ESP does not have.
            vm.expect("grubx64.efi", 60)
            return
        vm.press(b" ")
        vm.expect("Perform MOK management", 30)
        vm.expect("Enroll MOK", 30)
        vm.press(DOWN, ENTER)
        # [Enroll MOK]: View key 0, then Continue.
        vm.expect("View key 0", 30)
        vm.press(DOWN, ENTER)
        vm.expect("Enroll the key(s)?", 30)
        vm.press(DOWN, ENTER)
        vm.expect("Password", 30)
        vm.press(*[c.encode() for c in code], ENTER)
        vm.expect("Reboot", 30)
        vm.press(ENTER)
        # The firmware starts again: MokList was written before the reset.
        vm.expect("BdsDxe", 60)
    finally:
        vm.stop()


if __name__ == "__main__":
    if len(sys.argv) < 4 or "--" not in sys.argv:
        sys.exit(__doc__)
    main(*sys.argv[1:])
