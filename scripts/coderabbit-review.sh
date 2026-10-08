#!/usr/bin/env bash
# CodeRabbit CLI review of this branch against main, run by the no-mistakes
# lint step (.no-mistakes.yaml) just before the push.
#
# Exits 1 when CodeRabbit reports findings, so the lint fixer addresses them.
# Never blocks on CodeRabbit itself: when the CLI is missing, not signed in,
# rate-limited or offline, it prints a skip line and exits 0.
set -u

skip() {
  echo "coderabbit-review: skipped ($1)"
  exit 0
}

command -v coderabbit >/dev/null 2>&1 || skip "coderabbit CLI not installed"

# Checked first because a signed-out review starts an interactive browser login.
coderabbit auth status --agent 2>/dev/null | grep -Eq '"authenticated": *true' ||
  skip "coderabbit CLI not signed in; run: coderabbit auth login"

base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null) ||
  skip "no main branch to compare against"

# --agent prints one JSON event per line; the exit code is 0 with or without
# findings, so the events decide the result.
coderabbit review --agent --base-commit "$base" </dev/null 2>&1 | node -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n");
  const events = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const findings = events.filter((e) => e.type === "finding");
  const done = events.find((e) => e.type === "complete");
  if (done && done.status === "review_completed") {
    for (const f of findings) console.log(`\n[${f.severity}] ${f.fileName}\n${f.codegenInstructions}`);
    console.log(`\ncoderabbit-review: ${findings.length} finding(s)`);
    process.exit(findings.length > 0 ? 1 : 0);
  }
  if (done && done.status === "review_skipped") {
    console.log(`coderabbit-review: nothing to review (${done.message})`);
    process.exit(0);
  }
  const error = events.find((e) => e.type === "error");
  const reason = error ? error.message : lines.filter(Boolean).pop() || "no output";
  console.log(`coderabbit-review: skipped (review did not finish: ${reason})`);
'
