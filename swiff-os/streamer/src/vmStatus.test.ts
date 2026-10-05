import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const statusScript = fileURLToPath(new URL("../vm/vm-status.sh", import.meta.url));
const haveShell = spawnSync("sh", ["-c", "command -v timeout"]).status === 0;

/** run-test.sh's end of a run: boot the VM, then judge it with the harness's status. */
function vmRun(qemu: string, harnessStatus: number, timeout = 1) {
  const run = spawnSync(
    "sh",
    [
      "-c",
      `set -eu
. "$0"
sh -c "exit ${harnessStatus}" &
harness=$!
set +e
boot_vm ${qemu}
qemu=$?
set -e
status=0
run_status "$harness" "$qemu" || status=$?
exit "$status"`,
      statusScript,
    ],
    { env: { ...process.env, SWIFF_VM_TIMEOUT: String(timeout) }, timeout: 20_000 },
  );
  return run.status;
}

describe.skipIf(!haveShell)("the VM test's verdict", () => {
  it("fails a run whose VM never powers off, killed by the timeout, even when the harness passed", () => {
    expect(vmRun("sleep 30", 0)).toBe(124);
  });

  it("passes a run whose VM powered off and whose harness passed", () => {
    expect(vmRun("true", 0)).toBe(0);
  });

  it("fails with the harness's status when the harness failed", () => {
    expect(vmRun("true", 3)).toBe(3);
    expect(vmRun("sleep 30", 3)).toBe(3);
  });
});
