#!/usr/bin/env python3
"""Prints a key for what goes into an image build:

    inputs-key.py [--with TEXT]... PATH...

a hash of every file and directory under the PATHs (which PATH, its path
below it, mode, and a file's contents or a symlink's target), of each PATH that is a file itself, and of
each TEXT (a version, a profile). mkosi's
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


def add(h, index, name, path):
    """Hashes one input: which PATH it came from, its name below it, its mode, and its contents or target."""
    h.update(f"\0{index}\0{name}\0{os.lstat(path).st_mode:o}\0".encode())
    if os.path.isdir(path) and not os.path.islink(path):
        return
    if os.path.islink(path):
        h.update(os.readlink(path).encode())
    else:
        with open(path, "rb") as f:
            h.update(hashlib.file_digest(f, "sha256").digest())


h = hashlib.sha256("\0".join(args.texts).encode())
for index, top in enumerate(args.paths):
    if not os.path.isdir(top) or os.path.islink(top):
        add(h, index, os.path.basename(top), top)
        continue
    for root, dirs, files in os.walk(top):
        dirs[:] = sorted(d for d in dirs if d not in SKIP)
        # Directories too, for their modes: mkosi keeps them when it copies a tree.
        for name in sorted(dirs + [n for n in files if n not in SKIP]):
            path = os.path.join(root, name)
            add(h, index, os.path.relpath(path, top), path)
print(h.hexdigest()[:16])
