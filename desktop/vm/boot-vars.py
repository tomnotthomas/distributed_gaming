#!/usr/bin/env python3
"""The VM's UEFI variables, as the host app's rental-mode plans set them on a PC.

Stands in for bcdedit in the VM test (vm/rental-install-test.sh). Uses
virt-firmware (pip install virt-firmware) on an OVMF variable store:

  boot-vars.py init  VARS TEMPLATE DB_AUTH WIN_PART WIN_START WIN_SIZE WIN_UUID
      Secure Boot on with the certificate in DB_AUTH (the image's own
      db.auth, which systemd-boot would enrol) as PK, KEK and db, and a
      "Windows Boot Manager" entry for the fake Windows ESP, first and only
      in BootOrder: a PC as it comes.
  boot-vars.py entry VARS TITLE PART START SIZE UUID PATH
      add a boot entry for PATH on the GPT partition, last in BootOrder
      (bcdedit /copy {bootmgr}, /set device and path, displayorder /addlast)
  boot-vars.py first VARS TITLE      move the entry to the front of BootOrder (displayorder /addfirst)
  boot-vars.py next VARS TITLE       BootNext (bootsequence)
  boot-vars.py show VARS             print BootOrder, BootNext and the entries
"""

import struct
import sys
import tempfile

from virt.firmware.efi import devpath, guids, siglist, ucs16
from virt.firmware.varstore import autodetect

WINDOWS_PATH = "\\EFI\\Microsoft\\Boot\\bootmgfw.efi"


def load(path):
    store = autodetect.open_varstore(path)
    return store, store.get_varlist()


def save(store, varlist, path):
    store.write_varstore(path, varlist)


def cert_from_auth(path):
    """The first X.509 certificate in an authenticated variable file (EFI_VARIABLE_AUTHENTICATION_2)."""
    data = open(path, "rb").read()
    # EFI_TIME (16 bytes), then WIN_CERTIFICATE_UEFI_GUID whose dwLength covers itself.
    (cert_len,) = struct.unpack_from("<I", data, 16)
    sigdb = siglist.EfiSigDB(data[16 + cert_len :])
    for sigs in sigdb:
        if str(sigs.guid) == guids.EfiCertX509:
            return sigs[0]["data"]
    sys.exit(f"no certificate in {path}")


def hd_path(part, start, size, uuid, path):
    hd = devpath.DevicePathElem()
    hd.set_gpt(int(part), int(start), int(size), uuid)
    fp = devpath.DevicePathElem()
    fp.set_filepath(path)
    dp = devpath.DevicePath()
    dp.append(hd)
    dp.append(fp)
    return dp


def entries(varlist):
    """Boot#### index -> title."""
    found = {}
    for name, var in varlist.items():
        if len(name) == 8 and name.startswith("Boot") and name[4:] not in ("Next", "Curr"):
            try:
                index = int(name[4:], 16)
            except ValueError:
                continue
            found[index] = str(ucs16.from_ucs16(var.data, 6))
    return found


def index_of(varlist, title):
    for index, name in entries(varlist).items():
        if name == title:
            return index
    sys.exit(f"no boot entry {title!r}")


def order(varlist):
    var = varlist.get("BootOrder")
    if not var:
        return []
    return list(struct.unpack(f"<{len(var.data) // 2}H", var.data))


def set_order(varlist, indexes):
    var = varlist.get("BootOrder") or varlist.create("BootOrder")
    var.set_boot_order(indexes)


def main(cmd, vars_path, *args):
    if cmd == "init":
        template, db_auth, part, start, size, uuid = args
        store, varlist = load(template)
        with tempfile.NamedTemporaryFile(suffix=".der") as cert:
            cert.write(cert_from_auth(db_auth))
            cert.flush()
            owner = guids.OvmfEnrollDefaultKeys
            for name in ("PK", "KEK", "db"):
                varlist.add_cert(name, owner, cert.name, True)
        varlist.enable_secureboot()
        varlist.set_boot_entry(0, "Windows Boot Manager", hd_path(part, start, size, uuid, WINDOWS_PATH))
        set_order(varlist, [0])
        save(store, varlist, vars_path)
    elif cmd == "entry":
        title, part, start, size, uuid, path = args
        store, varlist = load(vars_path)
        index = varlist.add_boot_entry(title, hd_path(part, start, size, uuid, path))
        set_order(varlist, [i for i in order(varlist) if i != index] + [index])
        save(store, varlist, vars_path)
    elif cmd == "first":
        (title,) = args
        store, varlist = load(vars_path)
        index = index_of(varlist, title)
        set_order(varlist, [index] + [i for i in order(varlist) if i != index])
        save(store, varlist, vars_path)
    elif cmd == "next":
        (title,) = args
        store, varlist = load(vars_path)
        varlist.set_boot_next(index_of(varlist, title))
        save(store, varlist, vars_path)
    elif cmd == "show":
        _, varlist = load(vars_path)
        titles = entries(varlist)
        print("BootOrder:", ", ".join(f"Boot{i:04X} {titles.get(i, '?')!r}" for i in order(varlist)))
        nxt = varlist.get("BootNext")
        if nxt:
            (index,) = struct.unpack("<H", nxt.data)
            print(f"BootNext: Boot{index:04X} {titles.get(index, '?')!r}")
        else:
            print("BootNext: none")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
