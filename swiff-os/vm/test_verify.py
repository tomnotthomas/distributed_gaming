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
    """Writes bytes to a file, creating its folders."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def read(path):
    """Reads a file's bytes."""
    with open(path, "rb") as f:
        return f.read()


def sha(data):
    """The SHA-256 hex digest of bytes."""
    return hashlib.sha256(data).hexdigest()


class Library(unittest.TestCase):
    """A library folder with one game, Delta, and its verified table entry."""

    def setUp(self):
        """Builds a library folder with one verified game and points swiff-verify at it."""
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
        """Each game's state after a quick or full check."""
        games = verify.survey({"library": self.lib}, self.table, full)[0]
        return {appid: g["state"] for appid, g in games.items()}


class BlockedStays(Library):
    """A game blocked by a full re-hash stays blocked until it verifies again."""

    def test_a_block_survives_the_next_quick_check(self):
        """A same-size edit with the mtime put back stays blocked after a quick boot."""
        st = os.lstat(self.pak)
        write(self.pak, b"d-X" * 1000)  # same size, mtime put back
        os.utime(self.pak, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.states(full=True), {"1004": "blocked"})
        self.reload()
        self.assertEqual(self.states(full=False), {"1004": "blocked"})

    def test_a_blocked_game_that_passes_again_is_verified(self):
        """A restored file makes the blocked game verified again."""
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
    """The TPM clock decides between a quick check and a full re-hash."""
    table = {"reset_count": 7, "restart_count": 0}

    def test_the_next_clean_power_up_is_quick(self):
        """One more resetCount and no restart: a quick check."""
        self.assertFalse(verify.rehash_all((8, 0), self.table))

    def test_the_same_boot_is_quick(self):
        """The same clock (start run again): a quick check."""
        self.assertFalse(verify.rehash_all((7, 0), self.table))

    def test_another_power_up_rehashes(self):
        """Another OS powered up in between: a full re-hash."""
        self.assertTrue(verify.rehash_all((9, 0), self.table))

    def test_an_os_that_hibernated_rehashes(self):
        # Windows booted (8) and hibernated: the next start is a TPM Restart.
        """A TPM restart after another OS hibernated: a full re-hash."""
        self.assertTrue(verify.rehash_all((8, 1), self.table))

    def test_no_clock_or_no_record_rehashes(self):
        """No TPM clock or no recorded clock: a full re-hash."""
        self.assertTrue(verify.rehash_all(None, self.table))
        self.assertTrue(verify.rehash_all((8, 0), {"reset_count": None, "restart_count": None}))


class SessionSize(unittest.TestCase):
    """The session layer leaves room on the library for promotion."""

    def test_half_the_free_space_stays_free(self):
        """The session layer takes at most half the free space."""
        total, free = 1 << 40, 300 << 30
        size = verify.container_size(total, free)
        self.assertLessEqual(size, free - size)

    def test_the_owner_keeps_five_percent(self):
        """The owner keeps 5% of the volume free."""
        total, free = 100 << 30, 6 << 30
        self.assertLessEqual(verify.container_size(total, free), free - (5 << 30))


class Promotion(Library):
    """Promotion copies only what fits and verifies, owned like the game folder."""

    def setUp(self):
        """Adds a session layer holding an update of the game."""
        super().setUp()
        self.session = os.path.join(self.root, "session")
        self.new = b"d-2" * 1000
        write(os.path.join(self.session, "upper/steamapps/common/Delta/d.pak"), self.new)
        self.update = dict(self.entry, buildid="2", files={"d.pak": [len(self.new), sha(self.new), 0, 0, "10041"]})
        self.setup = {"session": self.session, "library": self.lib}

    def test_an_update_that_fits_is_promoted(self):
        """A sealed update that fits reaches the library."""
        verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(read(self.pak), self.new)
        self.assertEqual(verify.load_table(KEY)[0]["apps"]["1004"]["buildid"], "2")

    def test_everything_promoted_is_owned_like_the_game_folder(self):
        """Promoted files, folders and the app manifest get the game folder's owner."""
        update = dict(self.update, dirs={"data": "10041"})
        chowns, real_lstat, game = {}, os.lstat, os.lstat(self.game)

        def lstat(path):
            """The game folder as owned by another uid; other paths as they are."""
            return os.stat_result((game.st_mode, 0, 0, 0, 4242, 4343, 0, 0, 0, 0)) if path == self.game else real_lstat(path)

        with mock.patch.object(verify.os, "lchown", side_effect=lambda path, *owner: chowns.setdefault(path, owner)), \
                mock.patch.object(verify.os, "lstat", side_effect=lstat):
            verify.promote_app("1004", update, self.setup, self.table, KEY, True)
        promoted = {os.path.relpath(p, self.lib).removesuffix(verify.TEMP_SUFFIX) for p, owner in chowns.items() if owner == (4242, 4343)}
        self.assertEqual(promoted, {"steamapps/common/Delta/d.pak", "steamapps/common/Delta/data", "steamapps/depotcache", "steamapps/appmanifest_1004.acf"})

    def test_an_update_that_does_not_fit_stays_off_the_library(self):
        """An update larger than the free space is not promoted at all."""
        full = os.statvfs_result((4096, 4096, 1000, 0, 0, 1000, 0, 0, 0, 255))
        with mock.patch.object(verify.os, "statvfs", return_value=full):
            with self.assertRaisesRegex(verify.Refused, "stays on its verified version"):
                verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(read(self.pak), b"d-1" * 1000)
        self.assertEqual(os.listdir(self.game), ["d.pak"])
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))

    def test_a_copy_cut_short_leaves_nothing_behind(self):
        """A failed copy leaves no temporary file and the old version in place."""
        with mock.patch.object(verify, "copy_verified", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(OSError):
                verify.promote_app("1004", self.update, self.setup, self.table, KEY, True)
        self.assertEqual(os.listdir(self.game), ["d.pak"])

    def test_a_library_copy_is_promoted_only_when_it_still_matches(self):
        """A file sealed from the library's own copy is hashed again before it is recorded."""
        os.remove(os.path.join(self.session, "upper/steamapps/common/Delta/d.pak"))
        verify.promote_app("1004", self.entry, self.setup, self.table, KEY, False)
        self.assertEqual(verify.load_table(KEY)[0]["apps"]["1004"]["files"]["d.pak"][1], sha(b"d-1" * 1000))

    def test_a_changed_library_copy_is_refused(self):
        """A library copy that no longer matches its record, or cannot be read, is not promoted."""
        os.remove(os.path.join(self.session, "upper/steamapps/common/Delta/d.pak"))
        write(self.pak, b"d-X" * 1000)
        with self.assertRaisesRegex(verify.Refused, "does not match what was verified"):
            verify.promote_app("1004", self.entry, self.setup, self.table, KEY, False)
        with mock.patch.object(verify, "hash_file", side_effect=OSError(5, "Input/output error")):
            with self.assertRaisesRegex(verify.Refused, "cannot be read on the library"):
                verify.promote_app("1004", self.entry, self.setup, self.table, KEY, False)
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))


class FakeCreds:
    """systemd-creds: decrypt fails (a changed PCR 7), encrypt writes the key."""

    def __init__(self):
        """Counts decrypt attempts."""
        self.decrypts = 0

    def __call__(self, cmd, **kw):
        """Stands in for subprocess.run with systemd-creds."""
        cmd = list(cmd)
        if cmd[:2] == ["systemd-creds", "decrypt"]:
            self.decrypts += 1
            return subprocess.CompletedProcess(cmd, 1, b"", b"TPM2 policy does not match")
        if cmd[:2] == ["systemd-creds", "encrypt"]:
            write(cmd[-1], b"sealed:" + kw["input"])
            return subprocess.CompletedProcess(cmd, 0)
        return subprocess.CompletedProcess(cmd, 0, "", "")


class LockedKey(Library):
    """A table key that no longer unseals is kept until the owner bootstraps again."""

    def setUp(self):
        """Makes the table key a credential that does not unseal."""
        super().setUp()
        self.cred = os.path.join(self.volume, verify.KEY)
        write(self.cred, b"the old credential")
        self.creds = FakeCreds()
        for target, value in ((verify.subprocess, ("run", self.creds)), (verify.time, ("sleep", lambda _: None))):
            patch = mock.patch.object(target, *value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_key_that_does_not_unseal_is_kept(self):
        """The credential is retried, kept, and the table reported locked."""
        self.assertIsNone(verify.table_key(create=True))
        self.assertEqual(self.creds.decrypts, 3)
        self.assertEqual(read(self.cred), b"the old credential")
        self.assertEqual(verify.load_table(None)[1], verify.KEY_LOCKED)

    def stop(self, table_state, bootstrap):
        """Runs shutdown with one sealed game, as boot reported the table."""
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
        """The owner's bootstrap seals a new key and table."""
        self.stop(verify.KEY_LOCKED, bootstrap=True)
        sealed = read(self.cred)
        self.assertTrue(sealed.startswith(b"sealed:"))
        table, problem = verify.load_table(sealed.removeprefix(b"sealed:"))
        self.assertIsNone(problem)
        self.assertEqual(list(table["apps"]), ["1004"])

    def test_a_bootstrap_that_cannot_seal_keeps_it(self):
        """A failed seal at shutdown keeps the old credential and promotes nothing."""
        def encrypt_fails(cmd, **kw):
            """systemd-creds encrypt leaves a partial credential and fails."""
            cmd = list(cmd)
            if cmd[:2] == ["systemd-creds", "encrypt"]:
                write(cmd[-1], b"partial")
                raise subprocess.CalledProcessError(1, cmd)
            return self.creds(cmd, **kw)
        with mock.patch.object(verify.subprocess, "run", encrypt_fails):
            self.stop(verify.KEY_LOCKED, bootstrap=True)
        self.assertEqual(read(self.cred), b"the old credential")
        self.assertFalse(os.path.lexists(self.cred + verify.TEMP_SUFFIX))
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))

    def test_nothing_else_replaces_it(self):
        """A renter update, or a key that failed only now, replaces nothing."""
        self.stop(verify.KEY_LOCKED, bootstrap=False)
        self.assertEqual(read(self.cred), b"the old credential")
        # The key unsealed at boot and fails only now: not the owner's decision.
        self.stop("ok", bootstrap=True)
        self.assertEqual(read(self.cred), b"the old credential")
        self.assertFalse(os.path.exists(os.path.join(self.volume, verify.TABLE)))


class TableFile(Library):
    """Damaged tables fail the integrity check without crashing; newer tables are kept."""

    def test_a_table_that_is_not_an_object_is_refused_not_fatal(self):
        """JSON that is not a table object fails the integrity check without crashing."""
        for doc in (b"[]", b'"x"', b'{"hmac": "00", "table": []}'):
            write(os.path.join(self.volume, verify.TABLE), doc)
            table, problem = verify.load_table(KEY)
            self.assertEqual(problem, verify.TABLE_TAMPERED)
            self.assertEqual(table["apps"], {})

    def test_corrupt_bytes_are_not_kept(self):
        """Bytes that are not JSON count as a failed integrity check."""
        write(os.path.join(self.volume, verify.TABLE), b"\xff{not json")
        self.assertEqual(verify.load_table(KEY)[1], verify.TABLE_TAMPERED)

    def test_a_bootstrap_does_not_replace_a_newer_table(self):
        """Shutdown keeps a table of a newer version even for a bootstrap."""
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
    """Shutdown erases the session layer whatever promotion does."""

    def test_the_session_layer_goes_even_when_promotion_fails(self):
        """The session layer is closed and the volume unmounted when promotion raises."""
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


class Robustness(Library):
    """Bad input and a TPM that cannot seal leave the games service running."""

    def test_deeply_nested_keyvalues_are_invalid_not_fatal(self):
        """KeyValues nested past Python's recursion limit raise ValueError."""
        with self.assertRaises(ValueError):
            verify.parse_vdf('"a" {' * 5000 + "}" * 5000)

    def test_a_key_that_cannot_be_sealed_means_no_key(self):
        """A failed systemd-creds encrypt gives no key and leaves no file."""
        failed = subprocess.CalledProcessError(1, ["systemd-creds", "encrypt"])
        with mock.patch.object(verify, "run", side_effect=failed):
            self.assertIsNone(verify.table_key(create=True))
        self.assertFalse(os.path.lexists(os.path.join(self.volume, verify.KEY)))
        self.assertEqual(verify.load_table(None)[1], "no table key")


if __name__ == "__main__":
    unittest.main()
