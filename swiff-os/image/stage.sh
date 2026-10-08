#!/bin/sh
# Stages what the image takes from the rest of the repository into
# <output-dir>/stage, which mkosi adds as an extra tree (ExtraTrees=%O/stage in
# mkosi.images/system/mkosi.conf): swiff-hostd and its attestation client
# (swiff-attest), swiff-streamer and the Steam sign-in agent, each bundled into
# one file for the image's Node (Ubuntu's, built without TypeScript type
# stripping), swiff-hostd's own settings and the provisioning that completes
# them, the streamer's helpers and system files, the renter session, and the
# Steam client kept across reboots. Run it before every build of the image, with
# the same output directory mkosi gets; the build fails without it.
#
#   swiff-os/image/stage.sh <output-dir>
#
# Needs the repository's npm dependencies (npm ci).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
os=$(dirname "$here")
repo=$(dirname "$os")
out=${1:?usage: stage.sh <output-dir>}

(cd "$repo" && npm run build -w @swiff/hostd -w @swiff/os-streamer -w @swiff/steam-login) > /dev/null

stage=$out/stage
rm -rf "$stage"
# put MODE SOURCE TARGET: one file into the stage, at TARGET under /.
put() { install -D -m "$1" "$2" "$stage/$3"; }

put 0644 "$os/hostd/dist/swiff-hostd.mjs" usr/lib/swiff/hostd/swiff-hostd.mjs
put 0644 "$os/hostd/swiff-hostd.service" usr/lib/systemd/system/swiff-hostd.service
put 0644 "$os/hostd/dist/swiff-attest.mjs" usr/lib/swiff/hostd/swiff-attest.mjs
put 0755 "$os/hostd/system/swiff-attest" usr/libexec/swiff/swiff-attest
put 0644 "$os/hostd/swiff-provision.service" usr/lib/systemd/system/swiff-provision.service
put 0644 "$os/hostd/hostd.image.json" usr/lib/swiff/hostd.json

put 0644 "$os/streamer/dist/swiff-streamer.mjs" usr/lib/swiff/streamer/dist/swiff-streamer.mjs
put 0644 "$os/streamer/helpers/swiff-gst.py" usr/lib/swiff/streamer/helpers/swiff-gst.py
put 0644 "$os/streamer/helpers/swiff-uinput.py" usr/lib/swiff/streamer/helpers/swiff-uinput.py
put 0644 "$os/streamer/system/swiff-streamer.sysusers" usr/lib/sysusers.d/swiff-streamer.conf
put 0644 "$os/streamer/system/swiff-streamer.tmpfiles" usr/lib/tmpfiles.d/swiff-streamer.conf
put 0644 "$os/streamer/system/70-swiff-streamer.rules" usr/lib/udev/rules.d/70-swiff-streamer.rules
put 0755 "$os/streamer/system/swiff-pipewire-grant" usr/libexec/swiff/swiff-pipewire-grant
put 0644 "$os/streamer/system/swiff-pipewire-grant.service" usr/lib/systemd/user/swiff-pipewire-grant.service

put 0644 "$os/steam/dist/swiff-steam-login.mjs" usr/lib/swiff/steam/swiff-steam-login.mjs
put 0755 "$os/steam/session" usr/libexec/swiff/session
put 0755 "$os/steam/bin/zenity" usr/lib/swiff/steam/bin/zenity
put 0755 "$os/steam/client" usr/libexec/swiff/steam-client
put 0644 "$os/steam/swiff-steam-client.service" usr/lib/systemd/system/swiff-steam-client.service
put 0644 "$os/steam/swiff-steam-client-save.service" usr/lib/systemd/system/swiff-steam-client-save.service

echo "staged the image's agent, streamer and session in $stage"
