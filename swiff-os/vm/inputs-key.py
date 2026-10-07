#!/usr/bin/env python3
"""Prints a key for what goes into an image build:

    inputs-key.py [--with TEXT]... PATH...

a hash of every file under the PATHs (its path below the PATH, mode and
contents; a symlink's target) and of each TEXT (a version, a profile). mkosi's
output and caches and a private key are not inputs: mkosi.output, mkosi.cache,
mkosi.tools and mkosi.key are left out. The same inputs give the same key.
"""

import argparse
import hashlib
import os

SKIP = {"mkosi.output", "mkosi.cache", "mkosi.tools", "mkosi.key", "__pycache__"}

parser = argparse.ArgumentParser()
parser.add_argument("--with", dest="texts", action="append", default=[])
parser.add_argument("paths", nargs="+")
args = parser.parse_args()

h = hashlib.sha256("\0".join(args.texts).encode())
for top in args.paths:
    for root, dirs, files in os.walk(top):
        dirs[:] = sorted(d for d in dirs if d not in SKIP)
        links = [d for d in dirs if os.path.islink(os.path.join(root, d))]
        for name in sorted(n for n in files + links if n not in SKIP):
            path = os.path.join(root, name)
            h.update(f"\0{os.path.relpath(path, top)}\0{os.lstat(path).st_mode:o}\0".encode())
            if os.path.islink(path):
                h.update(os.readlink(path).encode())
            else:
                with open(path, "rb") as f:
                    h.update(hashlib.file_digest(f, "sha256").digest())
print(h.hexdigest()[:16])
