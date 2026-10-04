#!/usr/bin/env python3
"""The streamer's virtual keyboard, mouse, pointer and controllers, through uinput.

Runs as the streamer's user (swiff-stream), which may open /dev/uinput and
nothing else of the input stack. The streamer writes fixed records on stdin:

    u8 device, u16 type, u16 code, i32 value   (little-endian, 9 bytes)

and this replays each as a Linux input event on that device (uinputEvents.ts
numbers them). The streamer ends every batch with SYN_REPORT. Devices 0-2 are
created at start; a controller is created the first time it is used, so a
game sees only the controllers the renter has.

Closing stdin removes every device, which also lets go of anything held.

    swiff-uinput.py --keys 1,2,3,...   the keyboard's keys (keymap.ts)
    swiff-uinput.py --dry-run ...      print events instead of creating devices
"""

import argparse
import fcntl
import os
import signal
import struct
import sys

# linux/uinput.h and linux/input.h, for 64-bit and 32-bit alike.
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_DEV_SETUP = 0x405C5503  # _IOW('U', 3, struct uinput_setup), 92 bytes
UI_ABS_SETUP = 0x401C5504  # _IOW('U', 4, struct uinput_abs_setup), 28 bytes
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_SET_PHYS = 0x4000556C | struct.calcsize("P") << 16  # _IOW('U', 108, char *)

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
BUS_VIRTUAL, BUS_USB = 0x06, 0x03

RECORD = struct.Struct("<BHHi")
EVENT = struct.Struct("llHHi")  # struct input_event; the kernel stamps the time itself

# Matched by the image's udev rule, so the session can tell these from the PC's own devices.
PHYS = b"swiff-streamer\0"

MOUSE_BUTTONS = [0x110, 0x111, 0x112, 0x113, 0x114]  # BTN_LEFT .. BTN_EXTRA
REL_AXES = [0, 1, 6, 8, 11, 12]  # X, Y, HWHEEL, WHEEL, WHEEL_HI_RES, HWHEEL_HI_RES
PAD_BUTTONS = [0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x13A, 0x13B, 0x13C, 0x13D, 0x13E]
MAX_GAMEPADS = 4


def spec_keyboard(keys):
    return {"name": "Swiff virtual keyboard", "bus": BUS_VIRTUAL, "id": (0x5357, 0x0001),
            "keys": keys, "rel": [], "abs": {}}


def spec_mouse():
    return {"name": "Swiff virtual mouse", "bus": BUS_VIRTUAL, "id": (0x5357, 0x0002),
            "keys": MOUSE_BUTTONS, "rel": REL_AXES, "abs": {}}


def spec_pointer():
    # Buttons too, or udev does not take it for a pointer at all; the clicks
    # still come through the mouse.
    return {"name": "Swiff virtual pointer", "bus": BUS_VIRTUAL, "id": (0x5357, 0x0003),
            "keys": MOUSE_BUTTONS[:3], "rel": [],
            "abs": {0: (0, 65535, 0, 0), 1: (0, 65535, 0, 0)}}


def spec_gamepad(index):
    # An Xbox 360 pad as xpad presents one, so Steam Input and SDL map it
    # without being taught.
    stick = (-32768, 32767, 16, 128)
    return {"name": "Microsoft X-Box 360 pad", "bus": BUS_USB, "id": (0x045E, 0x028E),
            "version": 0x110, "keys": PAD_BUTTONS, "rel": [],
            "abs": {0: stick, 1: stick, 3: stick, 4: stick, 2: (0, 255, 0, 0), 5: (0, 255, 0, 0),
                    16: (-1, 1, 0, 0), 17: (-1, 1, 0, 0)}}


class Device:
    def __init__(self, spec, dry_run, out):
        self.spec = spec
        self.allowed = {(EV_SYN, 0)} | {(EV_KEY, k) for k in spec["keys"]} | \
            {(EV_REL, r) for r in spec["rel"]} | {(EV_ABS, a) for a in spec["abs"]}
        self.dry_run = dry_run
        self.out = out
        self.fd = None
        if dry_run:
            out.write(f"create {spec['name']}\n")
            return
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            ioctl = lambda req, arg: fcntl.ioctl(fd, req, arg)
            if spec["keys"]:
                ioctl(UI_SET_EVBIT, EV_KEY)
                for k in spec["keys"]:
                    ioctl(UI_SET_KEYBIT, k)
            if spec["rel"]:
                ioctl(UI_SET_EVBIT, EV_REL)
                for r in spec["rel"]:
                    ioctl(UI_SET_RELBIT, r)
            if spec["abs"]:
                ioctl(UI_SET_EVBIT, EV_ABS)
                for code, (lo, hi, fuzz, flat) in spec["abs"].items():
                    ioctl(UI_SET_ABSBIT, code)
                    ioctl(UI_ABS_SETUP, struct.pack("<H2x6i", code, 0, lo, hi, fuzz, flat, 0))
            ioctl(UI_SET_PHYS, PHYS)
            vendor, product = spec["id"]
            name = spec["name"].encode()[:79].ljust(80, b"\0")
            ioctl(UI_DEV_SETUP, struct.pack("<4H80sI", spec["bus"], vendor, product,
                                            spec.get("version", 1), name, 0))
            ioctl(UI_DEV_CREATE, 0)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd

    def write(self, type_, code, value):
        if (type_, code) not in self.allowed:
            return
        if self.dry_run:
            self.out.write(f"{self.spec['name']} {type_} {code} {value}\n")
            return
        try:
            os.write(self.fd, EVENT.pack(0, 0, type_, code, value))
        except BlockingIOError:
            pass  # the session is not reading; a dropped event beats a stalled streamer

    def close(self):
        if self.dry_run:
            self.out.write(f"destroy {self.spec['name']}\n")
        elif self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY, 0)
            finally:
                os.close(self.fd)
                self.fd = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keys", required=True, help="comma-separated Linux key codes")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    keys = [int(k) for k in args.keys.split(",") if k]
    out = sys.stdout

    devices = {}
    try:
        devices[0] = Device(spec_keyboard(keys), args.dry_run, out)
        devices[1] = Device(spec_mouse(), args.dry_run, out)
        devices[2] = Device(spec_pointer(), args.dry_run, out)
    except OSError as e:
        sys.stderr.write(f"[swiff-uinput] cannot create the virtual devices: {e.strerror}\n")
        for d in devices.values():
            d.close()
        return 1

    # SIGTERM from the streamer's own shutdown: remove the devices on the way out.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    pending = b""
    stdin = sys.stdin.buffer.raw
    try:
        while True:
            chunk = stdin.read(4096)
            if not chunk:
                break
            pending += chunk
            whole = len(pending) - len(pending) % RECORD.size
            for device, type_, code, value in RECORD.iter_unpack(pending[:whole]):
                if device not in devices:
                    index = device - 3
                    if not 0 <= index < MAX_GAMEPADS:
                        continue
                    try:
                        devices[device] = Device(spec_gamepad(index), args.dry_run, out)
                    except OSError as e:
                        sys.stderr.write(f"[swiff-uinput] cannot create controller {index}: {e.strerror}\n")
                        continue
                devices[device].write(type_, code, value)
            pending = pending[whole:]
            if args.dry_run:
                out.flush()
    finally:
        for d in devices.values():
            d.close()
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
