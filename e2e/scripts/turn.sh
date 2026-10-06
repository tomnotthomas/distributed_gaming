#!/bin/sh
# A TURN relay on this machine for the e2e tests and the streamer VM test:
# watching a crewmate is relay-only (server/src/watchIce.ts), so it needs one.
# coturn, on 127.0.0.1 only, with the test-only credential in
# e2e/tests/credentials.ts. Loopback peers are allowed: both browsers are here.
#
#   e2e/scripts/turn.sh [port]     TURNSERVER=<path> to use another coturn binary
#
# Then run the tests with E2E_TURN_URL=turn:127.0.0.1:<port> (default 3479).
set -eu
port=${1:-3479}
exec "${TURNSERVER:-turnserver}" -n --no-cli --no-tls --no-dtls \
    --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --listening-port="$port" \
    --min-port=49200 --max-port=49400 --allow-loopback-peers \
    --fingerprint --lt-cred-mech --realm=swiff.test \
    --user=swiff-e2e:e2e-only-turn-credential \
    --log-file=stdout --simple-log
