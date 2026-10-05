#!/usr/bin/env python3
"""Host-side tests of swiff-verify's decisions that the VM test cannot reach
or cannot reach cheaply: a TPM restart, a library that is short of space and
a table key that does not unseal. They run on plain folders; the TPM and
systemd-creds are stood in for.

Usage: python3 vm/test_verify.py
"""

import hashlib
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "../image/mkosi.images/system/mkosi.extra/usr/libexec/swiff/verify")
loader = importlib.machinery.SourceFileLoader("swiff_verify", SOURCE)
spec = importlib.util.spec_from_loader(loader.name, loader)
verify = importlib.util.module_from_spec(spec)
loader.exec_module(verify)

KEY = b"k" * 32


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Library(unittest.TestCase):
    """A library folder with one game, Delta, and its verified table entry."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.volume = os.path.join(self.root, "volume")
        self.lib = self.volume
        self.game = os.path.join(self.lib, "steamapps/common/Delta")
        self.pak = os.path.join(self.game, "d.pak")
        write(self.pak, b"d-1" * 1000)
        os.makedirs(os.path.join(self.volume, "SwiffOS"))
        st = os.lstat(self.pak)
        self.entry = {
            "name": "Delta", "buildid": "1", "installdir": "Delta", "depots": {"10041": "1004001"},
            "files": {"d.pak": [st.st_size, sha(b"d-1" * 1000), st.st_mtime_ns, 0, "10041"]},
            "dirs": {}, "symlinks": {}, "extras": [], "manifests": {}, "acf": '"AppState"\n{\n}\n',
        }
        self.table = {"version": 1, "reset_count": 7, "restart_count": 0, "apps": {"1004": self.entry}}
        for name in ("VOLUME", "SETUP", "SEALED", "REPORT"):
            patch = mock.patch.object(verify, name, os.path.join(self.root, name.lower()) if name != "VOLUME" else self.volume)
            patch.start()
            self.addCleanup(patch.stop)

    def reload(self):
        """The table as the next boot reads it."""
        verify.save_table(KEY, self.table)
        self.table, problem = verify.load_table(KEY)
        self.assertIsNone(problem)

    def states(self, full):
        games = verify.survey({"library": self.lib}, self.table, full)[0]
        return {appid: g["state"] for appid, g in games.items()}


class BlockedStays(Library):
    def test_a_block_survives_the_next_quick_check(self):
        st = os.lstat(self.pak)
        write(self.pak, b"d-X" * 1000)  # same size, mtime put back
        os.utime(self.pak, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.states(full=True), {"1004": "blocked"})
        self.reload()
        self.assertEqual(self.states(full=False), {"1004": "blocked"})

    def test_a_blocked_game_that_passes_again_is_verified(self):
        good = read(self.pak)
        st = os.lstat(self.pak)
        write(self.pak, b"d-X" * 1000)
        os.utime(self.pak, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.states(full=True), {"1004": "blocked"})
        write(self.pak, good)
        os.utime(self.pak, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.reload()
        self.assertEqual(self.states(full=False), {"1004": "verified"})
        self.assertNotIn("blocked", self.table["apps"]["1004"])


class Rehash(unittest.TestCase):
    table = {"reset_count": 7, "restart_count": 0}

    def test_the_next_clean_power_up_is_quick(self):
        self.assertFalse(verify.rehash_all((8, 0), self.table))

    def test_the_same_boot_is_quick(self):
        self.assertFalse(verify.rehash_all((7, 0), self.table))

    def test_another_power_up_rehashes(self):
        self.assertTrue(verify.rehash_all((9, 0), self.table))

    def test_an_os_that_hibernated_rehashes(self):
        # Windows booted (8) and hibernated: the next start is a TPM Restart.
        self.assertTrue(verify.rehash_all((8, 1), self.table))

    def test_no_clock_or_no_record_rehashes(self):
        self.assertTrue(verify.rehash_all(None, self.table))
        self.assertTrue(verify.rehash_all((8, 0), {"reset_count": None, "restart_count": None}))


class SessionSize(unittest.TestCase):
    def test_half_the_free_space_stays_free(self):
        total, free = 1 << 40, 300 << 30
        size = verify.container_size(total, free)
        self.assertLessEqual(size, free - size)

    def test_the_owner_keeps_five_percent(self):
        total, free = 100 << 30, 6 << 30
        self.assertLessEqual(verify.container_size(total, free), free - (5 << 30))


class Promotion(Library):
    def setUp(self):
        super().setUp()
        self.session = os.path.join(self.root, "session")
        self.new = b"d-2" * 1000
        write(os.path.join(self.session, "upper/steamapps/common/Delta/d.pak"), self.new)
        self.update = dict(self.entry, buildid="2", files={"d.pak": [len(self.new), sha(self.new), 0, 0, "10041"]})
        self.setup = {"session": self.session, "library": self.lib}

    def test_an_update_that_fits_is_promoted(self):
        verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(read(self.pak), self.new)
        self.assertEqual(verify.load_table(KEY)[0]["apps"]["1004"]["buildid"], "2")

    def test_everything_promoted_is_owned_like_the_game_folder(self):
        update = dict(self.update, dirs={"data": "10041"})
        chowns, real_lstat, game = {}, os.lstat, os.lstat(self.game)

        def lstat(path):
            return os.stat_result((game.st_mode, 0, 0, 0, 4242, 4343, 0, 0, 0, 0)) if path == self.game else real_lstat(path)

        with mock.patch.object(verify.os, "lchown", side_effect=lambda path, *owner: chowns.setdefault(path, owner)), \
                mock.patch.object(verify.os, "lstat", side_effect=lstat):
            verify.promote_app("1004", update, self.setup, self.table, KEY, True)
        promoted = {os.path.relpath(p, self.lib).removesuffix(verify.TEMP_SUFFIX) for p, owner in chowns.items() if owner == (4242, 4343)}
        self.assertEqual(promoted, {"steamapps/common/Delta/d.pak", "steamapps/common/Delta/data", "steamapps/depotcache", "steamapps/appmanifest_1004.acf"})

    def test_an_update_that_does_not_fit_stays_off_the_library(self):
        full = os.statvfs_result((4096, 4096, 1000, 0, 0, 1000, 0, 0, 0, 255))
        with mock.patch.object(verify.os, "statvfs", return_value=full):
            with self.assertRaisesRegex(verify.Refused, "stays on its verified version"):
                verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(read(self.pak), b"d-1" * 1000)
        self.assertEqual(os.listdir(self.game), ["d.pak"])
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))

    def test_a_copy_cut_short_leaves_nothing_behind(self):
        with mock.patch.object(verify, "copy_verified", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(OSError):
                verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(os.listdir(self.game), ["d.pak"])


class FakeCreds:
    """systemd-creds: decrypt fails (a changed PCR 7), encrypt writes the key."""

    def __init__(self):
        self.decrypts = 0

    def __call__(self, cmd, **kw):
        cmd = list(cmd)
        if cmd[:2] == ["systemd-creds", "decrypt"]:
            self.decrypts += 1
            return subprocess.CompletedProcess(cmd, 1, b"", b"TPM2 policy does not match")
        if cmd[:2] == ["systemd-creds", "encrypt"]:
            write(cmd[-1], b"sealed:" + kw["input"])
            return subprocess.CompletedProcess(cmd, 0)
        return subprocess.CompletedProcess(cmd, 0, "", "")


class LockedKey(Library):
    def setUp(self):
        super().setUp()
        self.cred = os.path.join(self.volume, verify.KEY)
        write(self.cred, b"the old credential")
        self.creds = FakeCreds()
        for target, value in ((verify.subprocess, ("run", self.creds)), (verify.time, ("sleep", lambda _: None))):
            patch = mock.patch.object(target, *value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_key_that_does_not_unseal_is_kept(self):
        self.assertIsNone(verify.table_key(create=True))
        self.assertEqual(self.creds.decrypts, 3)
        self.assertEqual(read(self.cred), b"the old credential")
        self.assertEqual(verify.load_table(None)[1], verify.KEY_LOCKED)

    def stop(self, table_state, bootstrap):
        session = os.path.join(self.root, "session")
        new = b"d-1" * 1000
        write(os.path.join(session, "upper/steamapps/common/Delta/d.pak"), new)
        with open(verify.SETUP, "w") as f:
            json.dump({"writable": True, "library": self.lib, "session": session}, f)
        with open(verify.REPORT, "w") as f:
            json.dump({"table": table_state, "games": {"1004": {"state": "blocked"}}}, f)
        write(os.path.join(verify.SEALED, "1004.json"), json.dumps({"bootstrap": bootstrap, "entry": self.entry}).encode())
        verify.cmd_stop([])

    def test_the_owners_bootstrap_replaces_it(self):
        self.stop(verify.KEY_LOCKED, bootstrap=True)
        sealed = read(self.cred)
        self.assertTrue(sealed.startswith(b"sealed:"))
        table, problem = verify.load_table(sealed.removeprefix(b"sealed:"))
        self.assertIsNone(problem)
        self.assertEqual(list(table["apps"]), ["1004"])

    def test_nothing_else_replaces_it(self):
        self.stop(verify.KEY_LOCKED, bootstrap=False)
        self.assertEqual(read(self.cred), b"the old credential")
        # The key unsealed at boot and fails only now: not the owner's decision.
        self.stop("ok", bootstrap=True)
        self.assertEqual(read(self.cred), b"the old credential")
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))


class TableFile(Library):
    def test_a_table_that_is_not_an_object_is_refused_not_fatal(self):
        for doc in (b"[]", b'"x"', b'{"hmac": "00", "table": []}'):
            write(os.path.join(self.volume, verify.TABLE), doc)
            table, problem = verify.load_table(KEY)
            self.assertEqual(problem, verify.TABLE_TAMPERED)
            self.assertEqual(table["apps"], {})

    def test_corrupt_bytes_are_not_kept(self):
        write(os.path.join(self.volume, verify.TABLE), b"\xff{not json")
        self.assertEqual(verify.load_table(KEY)[1], verify.TABLE_TAMPERED)

    def test_a_bootstrap_does_not_replace_a_newer_table(self):
        self.table["version"] = 2
        verify.save_table(KEY, self.table)
        path = os.path.join(self.volume, verify.TABLE)
        before = read(path)
        session = os.path.join(self.root, "session")
        write(os.path.join(session, "upper/steamapps/common/Delta/d.pak"), b"d-1" * 1000)
        with open(verify.SETUP, "w") as f:
            json.dump({"writable": True, "library": self.lib, "session": session}, f)
        with open(verify.REPORT, "w") as f:
            json.dump({"table": verify.TABLE_UNKNOWN, "games": {"1004": {"state": "blocked"}}}, f)
        write(os.path.join(verify.SEALED, "1004.json"), json.dumps({"bootstrap": True, "entry": self.entry}).encode())
        with mock.patch.object(verify, "table_key", lambda create: KEY):
            verify.cmd_stop([])
        self.assertEqual(read(path), before)


class StopCleansUp(Library):
    def test_the_session_layer_goes_even_when_promotion_fails(self):
        with open(verify.SETUP, "w") as f:
            json.dump({"writable": True, "library": self.lib, "session": verify.SESSION}, f)
        calls = []
        with mock.patch.object(verify, "umount", lambda path: calls.append(("umount", path))), \
                mock.patch.object(verify, "close_container", lambda: calls.append(("close",))), \
                mock.patch.object(verify, "promote_all", side_effect=OSError("promotion failed")):
            with self.assertRaises(OSError):
                verify.cmd_stop([])
        self.assertIn(("close",), calls)
        self.assertEqual(calls[-1], ("umount", verify.VOLUME))


if __name__ == "__main__":
    unittest.main()
