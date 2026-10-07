#!/usr/bin/env bash
# The relay scenario: a renter and a gaming PC on two networks with no path
# between them, and a TURN relay both can reach. The stream must fail without
# the relay and come up through it with one (relay.spec.ts).
#
#   renter netns              this script's netns                PC netns
#   10.20.1.2  ───veth───  10.20.1.1      10.20.2.1  ───veth───  10.20.2.2
#                          signaling, coturn
#                          no forwarding: nothing crosses between the two
#
# Each side reaches this netns's addresses, so the signaling server and the
# relay, and nothing beyond it: the other side's addresses are routed here and
# dropped. No STUN server is reachable either, so the only path is the relay.
#
# Needs no root: it runs in a user namespace of its own. Needs coturn's
# turnserver (TURNSERVER=path, else on PATH), Playwright's Chromium
# (npx playwright install chromium-headless-shell) and a build (npm run build).
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$script")/../.."

if [[ "${SWIFF_RELAY_INSIDE:-}" != 1 ]]; then
  exec env SWIFF_RELAY_INSIDE=1 unshare --user --map-root-user --net "$script" "$@"
fi

TURNSERVER="${TURNSERVER:-$(command -v turnserver || true)}"
if [[ ! -x "$TURNSERVER" ]]; then
  echo "coturn's turnserver not found: install coturn, or set TURNSERVER" >&2
  exit 2
fi
if [[ ! -f server/dist/index.js || ! -f web/dist/index.html ]]; then
  echo "not built: run npm run build" >&2
  exit 2
fi

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT

ip link set lo up
# Nothing crosses between the two networks.
echo 0 >/proc/sys/net/ipv4/ip_forward

# A network namespace for side $1 on 10.20.$2.0/24, held open by a sleeping
# process whose pid lands in ${1^^}_PID. Its localhost:8199 is forwarded to the
# signaling server on its link, so its pages load from a secure context, as
# they would over https.
netns() {
  unshare --net sleep infinity &
  local pid=$!
  pids+=("$pid")
  while [[ "$(readlink "/proc/$pid/ns/net")" == "$(readlink /proc/self/ns/net)" ]]; do sleep 0.05; done
  ip link add "$1-out" type veth peer name "$1-in"
  ip link set "$1-in" netns "$pid"
  ip addr add "10.20.$2.1/24" dev "$1-out"
  ip link set "$1-out" up
  nsenter -t "$pid" -n sh -c "ip link set lo up && ip addr add 10.20.$2.2/24 dev $1-in &&
    ip link set $1-in up && ip route add default via 10.20.$2.1"
  printf -v "${1^^}_PID" %s "$pid"
  nsenter -t "$pid" -n node -e '
    const net = require("node:net");
    net.createServer((c) => {
      const up = net.connect(8199, process.argv[1]);
      c.pipe(up).pipe(c);
      c.on("error", () => up.destroy());
      up.on("error", () => c.destroy());
    }).listen(8199, "127.0.0.1");' "10.20.$2.1" &
  pids+=("$!")
}
netns renter 1
netns host 2

out=e2e/.results/relay
# What coturn says about its users passes through here: for this user alone.
umask 077
mkdir -p "$out"
chmod 700 "$out"
rm -f "$out/turnserver.log" "$out/allocations.log" "$out/turnserver.fifo"
SWIFF_RELAY_TURN_SECRET="$(head -c 32 /dev/urandom | base64)"
# coturn's log names each TURN user, and those are credentials: it goes through
# a FIFO, never to disk, and only which side got an allocation is kept.
mkfifo -m 600 "$out/turnserver.fifo"
sed -unE 's/.*user <[0-9]+:[A-Za-z0-9_-]+-(renter|host)>: incoming packet ALLOCATE processed, success.*/allocated \1/p' \
  <"$out/turnserver.fifo" >"$out/allocations.log" &
pids+=("$!")
"$TURNSERVER" -n --listening-ip=10.20.1.1 --relay-ip=10.20.1.1 --listening-port=3478 \
  --min-port=49152 --max-port=49999 --use-auth-secret --static-auth-secret="$SWIFF_RELAY_TURN_SECRET" \
  --realm=swiff.test --no-tls --no-dtls --no-cli --verbose --simple-log --log-file="$out/turnserver.fifo" \
  --userdb="$out/turndb" >/dev/null 2>&1 &
pids+=("$!")

export RENTER_PID HOST_PID SWIFF_RELAY_TURN_SECRET
export SWIFF_RELAY_TURN_URLS="turn:10.20.1.1:3478"
export SWIFF_RELAY_TURN_LOG="$out/allocations.log"
npx playwright test -c e2e/relay/playwright.config.ts "$@"
