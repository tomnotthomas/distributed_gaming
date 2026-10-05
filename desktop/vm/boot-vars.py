#!/usr/bin/env python3
"""The VM's UEFI variables, as the host app's rental-mode plans set them on a PC.

Stands in for bcdedit in the VM test (vm/rental-install-test.sh). Uses
virt-firmware (pip install virt-firmware) on an OVMF variable store:

  boot-vars.py init  VARS TEMPLATE DB_AUTH WIN_PART WIN_START WIN_SIZE WIN_UUID
      Secure Boot on with the certificate in DB_AUTH (the image's own
      db.auth, which systemd-boot would enrol) as PK, KEK and db, or with
      TEMPLATE's own keys when DB_AUTH is "-" (OVMF's Microsoft keys), and a
      "Windows Boot Manager" entry for the fake Windows ESP, first and only
      in BootOrder: a PC as it comes.
  boot-vars.py entry VARS TITLE PART START SIZE UUID PATH
      add a boot entry for PATH on the GPT partition, last in BootOrder
      (bcdedit /copy {bootmgr}, /set device and path, displayorder /addlast)
  boot-vars.py first VARS TITLE      move the entry to the front of BootOrder (displayorder /addfirst)
  boot-vars.py next VARS TITLE       BootNext (bootsequence)
  boot-vars.py mok VARS NEW AUTH [TIMEOUT]
                                     MokNew, MokAuth (and MokTimeout) from the files NEW, AUTH
                                     (and TIMEOUT), as mokutil --import --timeout -1 queues
                                     Swiff's key for MokManager
  boot-vars.py secure-boot VARS on|off
                                     OVMF's Secure Boot switch, as its setup screen flips it
  boot-vars.py cert DB_AUTH OUT      the certificate in DB_AUTH, as DER, to OUT
  boot-vars.py show VARS             print BootOrder, BootNext, the queued MOK request and removal,
                                     MokTimeout and MokList
"""

import struct
import sys
import tempfile

from virt.firmware.efi import devpath, efivar, guids, siglist, ucs16
from virt.firmware.varstore import autodetect

WINDOWS_PATH = "\\EFI\\Microsoft\\Boot\\bootmgfw.efi"

# OVMF's Secure Boot switch (gEfiSecureBootEnableDisableGuid), which its setup screen flips.
SECURE_BOOT_ENABLE = "SecureBootEnable"

# Non-volatile, boot service and runtime access: what mokutil sets on MokNew and MokAuth.
NV_BS_RT = 7


def load(path):
    """The variable store at `path`, and its variables."""
    store = autodetect.open_varstore(path)
    return store, store.get_varlist()


def save(store, varlist, path):
    """Write `varlist` back to `store`'s file at `path`."""
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
    """A device path to the file `path` on GPT partition `part` (start and size in sectors)."""
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
    """The Boot#### index of the entry titled `title`; exits when there is none."""
    for index, name in entries(varlist).items():
        if name == title:
            return index
    sys.exit(f"no boot entry {title!r}")


def order(varlist):
    """BootOrder, as a list of Boot#### indexes."""
    var = varlist.get("BootOrder")
    if not var:
        return []
    return list(struct.unpack(f"<{len(var.data) // 2}H", var.data))


def set_order(varlist, indexes):
    """Set BootOrder to `indexes`, creating it when missing."""
    var = varlist.get("BootOrder") or varlist.create("BootOrder")
    var.set_boot_order(indexes)


def main(cmd, vars_path, *args):
    """Run one command from the usage above on the store at `vars_path`."""
    if cmd == "init":
        template, db_auth, part, start, size, uuid = args
        store, varlist = load(template)
        if db_auth != "-":
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
    elif cmd == "mok":
        names = ("MokNew", "MokAuth", "MokTimeout")
        store, varlist = load(vars_path)
        for name, path in zip(names, args):
            varlist[name] = efivar.EfiVar(name, guid=guids.Shim, attr=NV_BS_RT, data=open(path, "rb").read())
        save(store, varlist, vars_path)
    elif cmd == "secure-boot":
        (state,) = args
        store, varlist = load(vars_path)
        if state == "on":
            varlist.enable_secureboot()
        else:
            # OVMF's own switch, as its setup screen sets it: the keys stay enrolled.
            varlist[SECURE_BOOT_ENABLE].data = b"\x00"
        save(store, varlist, vars_path)
    elif cmd == "cert":
        (out,) = args
        with open(out, "wb") as f:
            f.write(cert_from_auth(vars_path))
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
        new, auth = varlist.get("MokNew"), varlist.get("MokAuth")
        if new or auth:
            print(f"MOK request: MokNew {len(new.data) if new else 0} bytes, MokAuth {len(auth.data) if auth else 0} bytes")
        else:
            print("MOK request: none")
        delete, delete_auth = varlist.get("MokDel"), varlist.get("MokDelAuth")
        if delete or delete_auth:
            print(f"MOK removal: MokDel {len(delete.data) if delete else 0} bytes, MokDelAuth {len(delete_auth.data) if delete_auth else 0} bytes")
        else:
            print("MOK removal: none")
        wait = varlist.get("MokTimeout")
        print(f"MokTimeout: {struct.unpack('<i', wait.data)[0] if wait and len(wait.data) == 4 else wait.data.hex() if wait else 'none'}")
        mok = varlist.get("MokList")
        print(f"MokList: {mok.data.hex() if mok else 'none'}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
