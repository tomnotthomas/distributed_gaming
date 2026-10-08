#!/usr/bin/env bash
# Runs scripts/coderabbit-review.sh against a fake coderabbit CLI and checks
# that only real findings fail it. Usage: bash scripts/coderabbit-review.test.sh
set -u

script="$(cd "$(dirname "$0")" && pwd)/coderabbit-review.sh"
bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT
failed=0

# The fake CLI answers `auth status` with $AUTH and `review` with $REVIEW,
# exiting with $REVIEW_EXIT.
cat >"$bin/coderabbit" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = auth ]; then echo "$AUTH"; else printf '%s\n' "$REVIEW"; exit "${REVIEW_EXIT:-0}"; fi
EOF
chmod +x "$bin/coderabbit"

# A throwaway repo with a main branch, so the base lookup never depends on
# the checkout the test runs in.
repo="$bin/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m base

signed_in='{"type":"status","phase":"auth","authenticated":true}'
signed_out='{"type":"status","phase":"auth","authenticated":false}'

check() { # name, expected exit, expected output fragment, then env for the fake CLI
  local name=$1 want=$2 fragment=$3 out got
  shift 3
  out=$(cd "$repo" && env "$@" bash "$script" 2>&1)
  got=$?
  if [ "$got" = "$want" ] && [[ $out == *"$fragment"* ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit $got (want $want), output: $out"
    failed=1
  fi
}

check "not installed" 0 "not installed" PATH=/usr/bin:/bin
check "signed out" 0 "not signed in" PATH="$bin:$PATH" AUTH="$signed_out"
check "findings fail" 1 "1 finding(s)" PATH="$bin:$PATH" AUTH="$signed_in" REVIEW='{"type":"finding","severity":"major","fileName":"a.ts","codegenInstructions":"Fix it"}
{"type":"complete","status":"review_completed","findings":1}'
check "finding without fix text" 1 '"comment":"Explain"' PATH="$bin:$PATH" AUTH="$signed_in" REVIEW='{"type":"finding","severity":"minor","fileName":"a.ts","comment":"Explain"}
{"type":"complete","status":"review_completed","findings":1}'
check "clean review" 0 "0 finding(s)" PATH="$bin:$PATH" AUTH="$signed_in" REVIEW='{"type":"complete","status":"review_completed","findings":0}'
check "no changes" 0 "nothing to review" PATH="$bin:$PATH" AUTH="$signed_in" REVIEW='{"type":"complete","status":"review_skipped","findings":0,"message":"No changes detected"}'
check "rate limited" 0 "skipped" PATH="$bin:$PATH" AUTH="$signed_in" REVIEW_EXIT=1 REVIEW='{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded"}'
check "network down" 0 "skipped" PATH="$bin:$PATH" AUTH="$signed_in" REVIEW_EXIT=1 REVIEW='Error: getaddrinfo ENOTFOUND api.coderabbit.ai'

exit $failed
