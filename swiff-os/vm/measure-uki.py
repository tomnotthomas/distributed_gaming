#!/usr/bin/env python3
# Prints the SHA-256 PCR 11 value a UKI produces once the system reaches the
# "ready" boot phase: systemd-stub measures each UKI section into PCR 11, then
# systemd extends it with the boot phases. run-test.sh runs this inside the
# build's tools tree (systemd-measure, python3-pefile) and compares the result
# with the PCR 11 the booted VM reports. It is the value the attestation
# verifier will expect for this UKI (report §5.3, stage 3).
import json
import os
import subprocess
import sys
import tempfile

import pefile

# The sections systemd-stub measures, in the names systemd-measure takes.
# .pcrsig is left out by design: it carries signatures over these values.
MEASURED = ["linux", "osrel", "cmdline", "initrd", "ucode", "splash", "dtb", "uname", "sbat", "pcrpkey"]
NOT_SUPPORTED = ["profile", "dtbauto", "hwids", "efifw"]
PHASES = "enter-initrd:leave-initrd:sysinit:ready"

pe = pefile.PE(sys.argv[1], fast_load=True)
sections = {s.Name.rstrip(b"\0").decode(): s for s in pe.sections}

for name in NOT_SUPPORTED:
    if "." + name in sections:
        sys.exit(f"UKI has a .{name} section, which this script does not measure")

with tempfile.TemporaryDirectory() as tmp:
    args = ["/usr/lib/systemd/systemd-measure", "calculate", "--bank=sha256", f"--phase={PHASES}", "--json=short"]
    for name in MEASURED:
        section = sections.get("." + name)
        if section is None:
            continue
        path = os.path.join(tmp, name)
        with open(path, "wb") as f:
            f.write(section.get_data(length=section.Misc_VirtualSize))
        args.append(f"--{name}={path}")
    result = json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)

print(result["sha256"][0]["hash"].lower())
