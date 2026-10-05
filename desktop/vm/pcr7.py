#!/usr/bin/env python3
"""PCR 7 (SHA-256) as a Windows start's TCG log replays it.

Used by vm/windows-install-test.sh to see what Windows Hello's PIN and
BitLocker would meet: both are sealed to PCR 7 (with PCR 11), so a start
whose PCR 7 differs from a clean start's loses the PIN (VBS key isolation)
or asks for BitLocker's recovery key. A start that went through Swiff's shim
and on into Windows in the same power-on has a different PCR 7; a clean
restart after MokManager's Reboot has the same one.

  pcr7.py LOG     prints the replayed PCR 7, in hex
"""

import hashlib
import struct
import sys

SHA256 = 0x000B
EV_NO_ACTION = 0x03


def events(data):
    """(pcr, type, {alg: digest}) for each event of a crypto-agile log."""
    size = struct.unpack_from("<I", data, 28)[0]
    spec = data[32 : 32 + size]
    if not spec.startswith(b"Spec ID Event03"):
        sys.exit("pcr7: not a crypto-agile TCG log")
    count = struct.unpack_from("<I", spec, 24)[0]
    sizes = dict(struct.unpack_from("<HH", spec, 28 + 4 * i) for i in range(count))
    at = 32 + size
    while at + 12 <= len(data):
        pcr, kind, n = struct.unpack_from("<III", data, at)
        at += 12
        digests = {}
        for _ in range(n):
            (alg,) = struct.unpack_from("<H", data, at)
            digests[alg] = data[at + 2 : at + 2 + sizes[alg]]
            at += 2 + sizes[alg]
        (length,) = struct.unpack_from("<I", data, at)
        at += 4 + length
        yield pcr, kind, digests


def main(path):
    pcr = bytes(32)
    for index, kind, digests in events(open(path, "rb").read()):
        if index == 7 and kind != EV_NO_ACTION:
            pcr = hashlib.sha256(pcr + digests[SHA256]).digest()
    print(pcr.hex())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
