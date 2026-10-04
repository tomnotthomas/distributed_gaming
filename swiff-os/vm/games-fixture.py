#!/usr/bin/env python3
"""Builds the games library and fixtures for the Stage 4 VM test (run-test.sh).

Usage: games-fixture.py OUTDIR

  OUTDIR/library/   the owner's Steam library as their Windows left it
  OUTDIR/fixtures/  what the VM's stand-in for Steam writes in each phase,
                    and expect.json with the digests the checks compare
  OUTDIR/tamper/    what the owner's Windows changes before the "tampered" boot

Five games, each with one depot:
  1001 Alpha    file names encrypted in its manifests (Steam's depot key is in
                the renter's Steam config); its settings.ini is a UserConfig
                file the owner changed. Gets a good update; later a planted DLL.
  1002 Bravo    the owner planted evil.dll before bootstrap. Its update does not
                match its manifest.
  1003 Charlie  one file damaged on the library, which Steam's validation
                repairs; the owner's mod files stay. Its update is changed by
                the session after it was sealed.
  1004 Delta    later modified by the owner's Windows.
  1005 Echo     never validated in rental mode; its manifest in the owner's
                depotcache is not trusted.
"""

import base64
import hashlib
import json
import os
import shutil
import struct
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

OWNER, RENTER = "76561190000000001", "76561190000000002"
PAYLOAD, METADATA, SIGNATURE, END = 0x71F617D0, 0x1F4812BE, 0x1B81B817, 0x32C415AB
USER_CONFIG, DIRECTORY = 0x1, 0x40
DEPOT_KEY = hashlib.sha256(b"swiff test depot key 10011").digest()


def blob(tag, size=6000, prefix=b""):
    """Deterministic test content."""
    out, i = bytearray(prefix), 0
    while len(out) < size:
        out += hashlib.sha256(f"{tag}/{i}".encode()).digest()
        i += 1
    return bytes(out[:size])


def exe(tag):
    return blob(tag, 9000, b"MZ\x90\x00")


GAMES = {
    "1001": {
        "name": "Alpha",
        "encrypted": True,
        "v1": {"Alpha.exe": exe("alpha-1"), "bin/engine.dll": exe("engine"), "bin/old.dll": exe("old"),
               "data/level1.pak": blob("level1"), "data/settings.ini": (blob("ini", 200), USER_CONFIG)},
        "v2": {"Alpha.exe": exe("alpha-2"), "bin/engine.dll": exe("engine"), "data/level1.pak": blob("level1"),
               "data/level2.pak": blob("level2"), "data/settings.ini": (blob("ini", 200), USER_CONFIG)},
    },
    "1002": {
        "name": "Bravo",
        "v1": {"Bravo.exe": exe("bravo-1"), "data/b.pak": blob("b-1")},
        "v2": {"Bravo.exe": exe("bravo-2"), "data/b.pak": blob("b-2")},
    },
    "1003": {
        "name": "Charlie",
        "v1": {"Charlie.exe": exe("charlie"), "data/c.pak": blob("c-1")},
        "v2": {"Charlie.exe": exe("charlie"), "data/c.pak": blob("c-2")},
    },
    "1004": {"name": "Delta", "v1": {"Delta.exe": exe("delta"), "data/d.pak": blob("d-1")}},
    "1005": {"name": "Echo", "v1": {"Echo.exe": exe("echo")}},
}


def depot(appid):
    return str(int(appid) * 10 + 1)


def gid(appid, version):
    return str(int(appid) * 1000 + version)


def files_of(game, version):
    """{path: (content, flags)}"""
    return {rel: v if isinstance(v, tuple) else (v, 0) for rel, v in game[f"v{version}"].items()}


def varint(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(num, value):
    if isinstance(value, int):
        return varint(num << 3) + varint(value)
    return varint(num << 3 | 2) + varint(len(value)) + value


def encrypt_name(name, key):
    iv = hashlib.md5(name.encode()).digest()
    raw = name.encode()
    pad = 16 - len(raw) % 16
    padded = raw + bytes([pad]) * pad
    ecb = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    cbc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return base64.b64encode(ecb.update(iv) + ecb.finalize() + cbc.update(padded) + cbc.finalize()).decode()


def manifest(appid, version, files, encrypted=False):
    """A Steam depot manifest in depotcache's binary protobuf format."""

    def enc(rel):
        name = rel.replace("/", "\\")  # a Windows depot
        return (encrypt_name(name, DEPOT_KEY) if encrypted else name).encode()

    payload = b""
    for d in sorted({rel.rsplit("/", 1)[0] for rel in files if "/" in rel}):
        payload += field(1, field(1, enc(d)) + field(2, 0) + field(3, DIRECTORY))
    for rel, (data, flags) in sorted(files.items()):
        mapping = (field(1, enc(rel)) + field(2, len(data)) + field(3, flags)
                   + field(4, hashlib.sha1(rel.replace("/", "\\").lower().encode()).digest())
                   + field(5, hashlib.sha1(data).digest()))
        payload += field(1, mapping)
    meta = (field(1, int(depot(appid))) + field(2, int(gid(appid, version))) + field(3, 1790812800)
            + field(4, int(encrypted)))
    return (struct.pack("<II", PAYLOAD, len(payload)) + payload + struct.pack("<II", METADATA, len(meta)) + meta
            + struct.pack("<II", SIGNATURE, 0) + struct.pack("<I", END))


def acf(appid, game, version, owner):
    size = sum(len(d) for d, _ in files_of(game, version).values())
    return f'''"AppState"
{{
\t"appid"\t\t"{appid}"
\t"Universe"\t\t"1"
\t"name"\t\t"{game['name']}"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"{game['name']}"
\t"buildid"\t\t"{version}"
\t"LastOwner"\t\t"{owner}"
\t"InstalledDepots"
\t{{
\t\t"{depot(appid)}"
\t\t{{
\t\t\t"manifest"\t\t"{gid(appid, version)}"
\t\t\t"size"\t\t"{size}"
\t\t}}
\t}}
}}
'''


def put(root, rel, data):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data.encode() if isinstance(data, str) else data)


def main(out):
    shutil.rmtree(out, ignore_errors=True)
    lib, fix, tamper = (os.path.join(out, d) for d in ("library", "fixtures", "tamper"))
    sa = "steamapps"
    expect = {"owner": OWNER, "v1": {}, "v2": {}}

    # The owner's library, as their Windows left it.
    put(lib, f"{sa}/libraryfolder.vdf", '"libraryfolder"\n{\n\t"contentid"\t\t"1"\n\t"label"\t\t""\n}\n')
    for appid, game in GAMES.items():
        put(lib, f"{sa}/appmanifest_{appid}.acf", acf(appid, game, 1, OWNER))
        for rel, (data, _) in files_of(game, 1).items():
            put(lib, f"{sa}/common/{game['name']}/{rel}", data)
        for v in (1, 2):
            if f"v{v}" in game:
                expect[f"v{v}"][appid] = {rel: hashlib.sha256(d).hexdigest() for rel, (d, _) in files_of(game, v).items()}
    put(lib, f"{sa}/common/Alpha/data/settings.ini", "owner's own settings\n")
    put(lib, f"{sa}/common/Bravo/evil.dll", exe("evil"))
    put(lib, f"{sa}/common/Charlie/data/c.pak", blob("c-damaged"))
    put(lib, f"{sa}/common/Charlie/mods/dxgi.dll", exe("reshade"))
    put(lib, f"{sa}/common/Charlie/readme-mod.txt", "a mod the owner installed\n")
    put(lib, f"{sa}/depotcache/{depot('1005')}_{gid('1005', 1)}.manifest", manifest("1005", 1, files_of(GAMES["1005"], 1)))

    # Bootstrap: Steam, signed in as the owner, validates 1001-1004. It
    # fetches their manifests and repairs Charlie's damaged file.
    boot = os.path.join(fix, "bootstrap")
    for appid in ("1001", "1002", "1003", "1004"):
        game = GAMES[appid]
        put(boot, f"{sa}/depotcache/{depot(appid)}_{gid(appid, 1)}.manifest",
            manifest(appid, 1, files_of(game, 1), game.get("encrypted", False)))
        put(boot, f"{sa}/appmanifest_{appid}.acf", acf(appid, game, 1, OWNER))
    put(boot, f"{sa}/common/Charlie/data/c.pak", blob("c-1"))
    put(fix, "steam/config/config.vdf",
        '"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"depots"\n'
        f'\t\t\t\t{{\n\t\t\t\t\t"{depot("1001")}"\n\t\t\t\t\t{{\n\t\t\t\t\t\t"DecryptionKey"\t\t"{DEPOT_KEY.hex()}"\n'
        '\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n')

    # Update: the renter's Steam updates Alpha (good), Bravo (b.pak does not
    # match its manifest) and Charlie (good until the session changes it).
    upd = os.path.join(fix, "update")
    for appid in ("1001", "1002", "1003"):
        game = GAMES[appid]
        put(upd, f"{sa}/depotcache/{depot(appid)}_{gid(appid, 2)}.manifest",
            manifest(appid, 2, files_of(game, 2), game.get("encrypted", False)))
        put(upd, f"{sa}/appmanifest_{appid}.acf", acf(appid, game, 2, RENTER))
        old = files_of(game, 1)
        for rel, (data, _) in files_of(game, 2).items():
            if rel not in old or old[rel][0] != data:
                put(upd, f"{sa}/common/{game['name']}/{rel}", data)
    put(upd, f"{sa}/common/Bravo/data/b.pak", blob("b-2-corrupt"))
    put(fix, "update-remove", f"{sa}/common/Alpha/bin/old.dll\n")

    # The owner's Windows, later: a DLL planted in Alpha, Delta's data changed.
    put(tamper, "Alpha-version.dll", exe("planted"))
    put(tamper, "Delta-d.pak", blob("d-tampered"))

    put(fix, "expect.json", json.dumps(expect, indent=1, sort_keys=True))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} OUTDIR")
    main(sys.argv[1])
