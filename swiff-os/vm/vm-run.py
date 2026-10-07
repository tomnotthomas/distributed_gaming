#!/usr/bin/env python3
"""Runs one test VM's QEMU within this PC's memory, and stops it when it hangs.

    vm-run.py [--name NAME] [--timeout S] [--stall S --progress FILE] -- QEMU-COMMAND...
    vm-run.py --room MIB

QEMU-COMMAND is the VM's QEMU command line (with `sudo -n ... -runas USER` in
front, when QEMU needs it); its -m is the VM's memory. Every VM test on this PC
starts its QEMU through here, so that they share one budget:

  room      QEMU starts once the test VMs running on this PC (any QEMU, however
            it was started) and this one have at most $SWIFF_VM_RAM_BUDGET MiB
            (8192) between them, and the PC has this VM's memory and
            $SWIFF_VM_HEADROOM MiB (1536) more available. It waits up to
            $SWIFF_VM_WAIT seconds (3600) for that, then exits 75.
  scope     QEMU runs in a systemd user scope of its own, its memory capped a
            little above the VM's and never swapped: a guest whose memory the
            host swaps out stalls, and swapping is what freezes this PC. With no
            user systemd it runs as it is. Either way, the kernel's OOM killer
            takes QEMU before anything else.
  watchdog  QEMU is stopped (SIGTERM, SIGKILL 10 s later) and this exits
              124  after --timeout seconds (0: never)
              125  when --progress (the VM's serial log) has not grown for
                   --stall seconds (0: never)
              137  when the PC runs out of memory: under $SWIFF_VM_MIN_AVAILABLE
                   MiB (512) available, or tasks stalled on memory more than
                   40% of the last 10 s (PSI), for 6 s on end. The newest
                   test VM goes first.
            and says why on stderr. Otherwise it exits with QEMU's status.

--room only waits until a VM of MIB MiB would start, for a test that has to
know before it starts what drives the VM; that VM's own start checks again.

Stopping this stops QEMU: SIGTERM/SIGINT/SIGHUP are passed on, and QEMU gets
SIGKILL when this is killed outright. SIGUSR1 cuts the VM's power: QEMU gets
SIGKILL, and this exits 0 once QEMU has. The run's state is in $SWIFF_VM_STATE
(default ~/.cache/swiff-vm).
"""

import argparse
import ctypes
import fcntl
import os
import re
import signal
import subprocess
import sys
import time

BUDGET = int(os.environ.get("SWIFF_VM_RAM_BUDGET", "8192"))
HEADROOM = int(os.environ.get("SWIFF_VM_HEADROOM", "1536"))
WAIT = int(os.environ.get("SWIFF_VM_WAIT", "3600"))
MIN_AVAILABLE = int(os.environ.get("SWIFF_VM_MIN_AVAILABLE", "512"))
PSI_FULL = 40.0
STATE = os.environ.get("SWIFF_VM_STATE") or os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "swiff-vm"
)
VMS = os.path.join(STATE, "vms")


def say(name, text):
    """Prints a line about VM `name` on stderr, where the test's log has it."""
    print(f"vm-run[{name}]: {text}", file=sys.stderr, flush=True)


def mem_mib(cmd):
    """The VM's memory in MiB from QEMU's -m (2048, 2G, size=2048M,...)."""
    for i, arg in enumerate(cmd[:-1]):
        if arg == "-m":
            value = cmd[i + 1].split(",")[0].removeprefix("size=")
            m = re.fullmatch(r"(\d+)([KMGT]?)i?B?", value, re.I)
            if m:
                n, unit = int(m.group(1)), m.group(2).upper()
                return {"K": n // 1024, "": n, "M": n, "G": n * 1024, "T": n * 1024 * 1024}[unit]
    return 128  # QEMU's default


def meminfo(key):
    """A /proc/meminfo value (MemAvailable, ...) in MiB, 0 when it has none."""
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1]) // 1024
    return 0


def psi_full_avg10():
    """The share of the last 10 s all tasks were stalled on memory (PSI), in %, 0 without PSI."""
    try:
        with open("/proc/pressure/memory") as f:
            for line in f:
                if line.startswith("full"):
                    return float(line.split()[1].split("=")[1])
    except OSError:
        pass
    return 0.0


def start_time(pid):
    """When the process started (clock ticks since boot), or None when it is gone."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        return None


def ancestry(pid):
    """The process and its parents, up to init."""
    chain = []
    while pid > 1 and len(chain) < 8:
        chain.append(pid)
        try:
            with open(f"/proc/{pid}/stat") as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            break
    return chain


def running_vms():
    """The memory of every QEMU on this PC, by pid."""
    vms = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
        except OSError:
            continue
        if cmd and os.path.basename(cmd[0]).startswith("qemu-system"):
            vms[int(pid)] = mem_mib(cmd)
    return vms


def wait_for_room(name, mem):
    """Takes the start lock once the budget and the PC have room for `mem` MiB; returns the lock."""
    deadline = time.monotonic() + WAIT
    told = 0.0
    lock = open(os.path.join(STATE, "start.lock"), "w")
    while True:
        # Held until this QEMU shows up in /proc, so that two starts never count the same room.
        fcntl.flock(lock, fcntl.LOCK_EX)
        used = sum(running_vms().values())
        available = meminfo("MemAvailable")
        if used + mem <= BUDGET and available >= mem + HEADROOM:
            return lock
        fcntl.flock(lock, fcntl.LOCK_UN)
        if time.monotonic() > deadline:
            say(name, f"no room for a {mem} MiB VM after {WAIT} s: test VMs hold {used} of {BUDGET} MiB, "
                f"{available} MiB available (needs {mem + HEADROOM})")
            sys.exit(75)
        if time.monotonic() - told > 60:
            told = time.monotonic()
            say(name, f"waiting for room for a {mem} MiB VM: test VMs hold {used} of {BUDGET} MiB, "
                f"{available} MiB available (needs {mem + HEADROOM})")
        time.sleep(5)


def host_uid():
    """This user's uid outside any user namespace (the session test runs as its root)."""
    uid = os.getuid()
    try:
        with open("/proc/self/uid_map") as f:
            for line in f:
                inside, outside, count = map(int, line.split())
                if inside <= uid < inside + count:
                    return outside + uid - inside
    except (OSError, ValueError):
        pass
    return uid


def user_scope(mem):
    """systemd-run's arguments for a scope with QEMU's memory capped and unswapped, or [] without a user systemd."""
    env = os.environ
    runtime = f"/run/user/{host_uid()}"
    if not env.get("XDG_RUNTIME_DIR") and os.path.isdir(runtime):
        env["XDG_RUNTIME_DIR"] = runtime
    scope = ["systemd-run", "--user", "--scope", "--quiet", "--collect"]
    try:
        subprocess.run(scope + ["true"], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return []
    # QEMU's own memory and its share of the page cache on top of the guest's.
    return scope + [f"--property=MemoryMax={mem + 512 + mem // 8}M", "--property=MemorySwapMax=0", "--"]


def registered():
    """The start times of the VMs started through here that still run; forgets the others."""
    vms = {}
    for entry in os.listdir(VMS):
        t = start_time(int(entry)) if entry.isdigit() else None
        if t is None:
            try:
                os.unlink(os.path.join(VMS, entry))
            except OSError:
                pass
        else:
            vms[int(entry)] = t
    return vms


def die_with_parent():
    """In the child: SIGKILL when vm-run.py dies, however it dies."""
    ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG


def main():
    """Waits for room, starts QEMU in its scope and watches it until it exits or is stopped."""
    parser = argparse.ArgumentParser(usage=__doc__.split("\n\n")[1].strip())
    parser.add_argument("--name", default="vm")
    parser.add_argument("--timeout", type=int, default=0)
    parser.add_argument("--stall", type=int, default=0)
    parser.add_argument("--progress")
    parser.add_argument("--room", type=int)
    parser.add_argument("command", nargs="*")
    args = parser.parse_args()
    name, cmd = args.name, args.command
    os.makedirs(VMS, exist_ok=True)
    if args.room:
        wait_for_room(name, args.room).close()
        return
    if not cmd:
        parser.error("no QEMU command")
    mem = mem_mib(cmd)

    lock = wait_for_room(name, mem)
    scope = user_scope(mem)
    if not scope:
        say(name, "no user systemd: QEMU runs without its own memory cap")
    # The kernel's OOM killer takes QEMU first.
    full = scope + ["choom", "-n", "800", "--"] + cmd
    proc = subprocess.Popen(full, start_new_session=True, preexec_fn=die_with_parent)
    mark = None

    def stop(why, status, signals=(signal.SIGTERM, signal.SIGKILL)):
        """Stops QEMU (each of `signals` in turn, 10 s apart), forgets the VM and exits with `status`."""
        if why:
            say(name, why)
        for sig in signals:
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                break
            except PermissionError:
                subprocess.run(["sudo", "-n", "kill", f"-{sig.name}", "--", f"-{proc.pid}"],
                               stderr=subprocess.DEVNULL)
            try:
                proc.wait(10)
                break
            except subprocess.TimeoutExpired:
                pass
        if mark:
            try:
                os.unlink(mark)
            except OSError:
                pass
        sys.exit(status)

    # Right after QEMU starts: a signal from here on stops it too. SIGUSR1 cuts its power
    # (SIGKILL, as at the wall) for a test that asks for that, and is no failure.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda n, _f: stop(None, 128 + n))
    signal.signal(signal.SIGUSR1, lambda _n, _f: stop(None, 0, (signal.SIGKILL,)))

    started = time.monotonic()
    registered()
    mark = os.path.join(VMS, str(proc.pid))
    with open(mark, "w") as f:
        f.write(f"{name} {mem}\n")
    # Holds the start lock until QEMU counts: the child itself once it has
    # exec'd into QEMU, or (through sudo) one of its children.
    is_vm = any(os.path.basename(a).startswith("qemu-system") for a in cmd[:4])
    for _ in range(100 if is_vm else 0):
        if proc.poll() is not None or any(proc.pid in ancestry(p) for p in running_vms()):
            break
        time.sleep(0.1)
    lock.close()

    progress_size, progress_at = -1, started
    short = 0
    while True:
        try:
            status = proc.wait(2)
            stop(None, 128 - status if status < 0 else status)
        except subprocess.TimeoutExpired:
            pass
        now = time.monotonic()
        if args.timeout and now - started > args.timeout:
            stop(f"stopped the VM: still running after {args.timeout} s", 124)
        if args.stall and args.progress:
            try:
                size = os.path.getsize(args.progress)
            except OSError:
                size = 0
            if size != progress_size:
                progress_size, progress_at = size, now
            elif now - progress_at > args.stall:
                stop(f"stopped the VM: its console ({args.progress}) has been silent for {args.stall} s", 125)
        available, pressure = meminfo("MemAvailable"), psi_full_avg10()
        short = short + 1 if available < MIN_AVAILABLE or pressure > PSI_FULL else 0
        if short >= 3:
            # The newest test VM goes first; the next one's watchdog looks again 2 s later.
            mine = start_time(proc.pid) or 0
            if not any(t > mine for t in registered().values()):
                stop(f"stopped the VM: the PC is out of memory ({available} MiB available, "
                     f"tasks stalled on memory {pressure:.0f}% of the last 10 s)", 137)


if __name__ == "__main__":
    main()
