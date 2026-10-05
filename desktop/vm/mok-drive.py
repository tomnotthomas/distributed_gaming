#!/usr/bin/env python3
"""Boots a VM into shim's MokManager and plays the owner at its blue screen.

Used by vm/mok-enroll-test.sh. OVMF mirrors its console on the serial port,
so this reads MokManager's screens there and types on it, as the owner would
on the PC's keyboard, following the steps the host app shows (MOK_SCREENS in
src/rental.ts):

  mok-drive.py LOG miss SECONDS -- QEMU...   wait SECONDS at the menu (it must still be there,
                                             MokTimeout -1), then the wrong choice, Continue boot:
                                             the request is used up
  mok-drive.py LOG confirm CODE -- QEMU...   Enroll MOK, Continue, Yes, the code, Reboot
  mok-drive.py LOG remove CODE -- QEMU...    Delete MOK, Continue, Yes, the code, Reboot

The host app queues each request with MokTimeout -1, so MokManager opens its
menu at once and waits: no "Press any key" countdown comes first.

QEMU... is the full QEMU command line, without a serial option. Instead of
`-- QEMU...`, `--socket PATH` plays the owner on a VM already running, on its
serial port's UNIX socket (windows-install-test.sh), and `wait TEXT SECONDS`
only waits for TEXT there. Exits nonzero when a screen the owner is told about
does not come. With `--loose`, only the first screen must come: a VM with a
graphics card mirrors MokManager's later screens to the serial port only in
pieces, so the keys are then pressed at their own pace and the caller checks
the outcome (MokList, or Swiff OS starting through shim).
"""

import os
import re
import select
import socket
import subprocess
import sys
import time

ANSI = re.compile(rb"\x1b\[[0-9;?=]*[A-Za-z]")
DOWN = b"\x1b[B"
ENTER = b"\r"


class Vm:
    def __init__(self, qemu, log, sock=None):
        if sock:
            self.proc = None
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(sock)
            self.out = self.sock
            self.send = self.sock.sendall
        else:
            self.proc = subprocess.Popen(
                qemu + ["-serial", "stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE
            )
            self.out = self.proc.stdout

            def send(data):
                self.proc.stdin.write(data)
                self.proc.stdin.flush()

            self.send = send
        self.log = open(log, "wb")
        self.seen = b""

    def expect(self, text, timeout, required=True):
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
            ready, _, _ = select.select([self.out], [], [], 0.5)
            if ready:
                chunk = os.read(self.out.fileno(), 65536)
                if not chunk:
                    break
                self.log.write(chunk)
                self.log.flush()
                self.seen += chunk
        if not required:
            print(f"mok-drive: {text!r} not seen on the serial port, going on", file=sys.stderr)
            return
        sys.exit(f"mok-drive: no {text!r} on the screen within {timeout} s")

    def log_bytes(self):
        """Everything the serial port showed so far."""
        self.log.flush()
        with open(self.log.name, "rb") as f:
            return f.read()

    def quiet(self, texts, seconds):
        """Waits `seconds`, failing if any of `texts` shows up meanwhile."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([self.out], [], [], 0.5)
            if ready:
                chunk = os.read(self.out.fileno(), 65536)
                if not chunk:
                    break
                self.log.write(chunk)
                self.seen += chunk
            plain = ANSI.sub(b"", self.seen).decode("latin-1")
            for text in texts:
                if text in plain:
                    sys.exit(f"mok-drive: {text!r} came while MokManager should have waited")

    def press(self, *keys):
        """Types keys one at a time, as a person would, once the screen has settled."""
        time.sleep(1)
        for key in keys:
            self.send(key)
            time.sleep(0.3)

    def stop(self):
        if not self.proc:
            self.sock.close()
            return
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def main(log, mode, *rest):
    if "--socket" in rest:
        vm = Vm(None, log, rest[rest.index("--socket") + 1])
    else:
        vm = Vm(list(rest[rest.index("--") + 1 :]), log)
    code = rest[0] if mode in ("confirm", "remove") else None
    loose = "--loose" in rest
    # A screen that may come in pieces: waited for, but not required, with --loose.
    def screen(text, timeout=30):
        vm.expect(text, 8 if loose else timeout, required=not loose)
    try:
        if mode == "wait":
            vm.expect(rest[0], int(rest[1]))
            return
        # The menu at once, without the countdown (MokTimeout -1).
        vm.expect("Perform MOK management", 120)
        if "Press any key to perform MOK management" in ANSI.sub(b"", vm.log_bytes()).decode("latin-1"):
            sys.exit("mok-drive: MokManager counted down instead of waiting (MokTimeout not honoured)")
        if mode == "miss":
            # Still waiting after the time the countdown would have given.
            vm.quiet(["Booting in", "grubx64.efi"], int(rest[0]))
            # Continue boot, the first item: the request is gone, and shim goes on
            # to its next stage, which this ESP lacks.
            vm.press(ENTER)
            vm.expect("grubx64.efi", 60)
            return
        action = "Enroll" if mode == "confirm" else "Delete"
        screen(f"{action} MOK")
        vm.press(DOWN, ENTER)
        # [Enroll MOK] or [Delete MOK]: View key 0, then Continue.
        screen("View key 0")
        vm.press(DOWN, ENTER)
        screen(f"{action} the key(s)?")
        vm.press(DOWN, ENTER)
        screen("Password")
        vm.press(*[c.encode() for c in code], ENTER)
        screen("Reboot")
        vm.press(ENTER)
        # The firmware starts again: MokList was written before the reset.
        vm.expect("BdsDxe", 60)
    finally:
        vm.stop()


if __name__ == "__main__":
    if len(sys.argv) < 4 or ("--" not in sys.argv and "--socket" not in sys.argv):
        sys.exit(__doc__)
    main(*sys.argv[1:])
