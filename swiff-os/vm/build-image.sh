#!/usr/bin/env bash
# Builds a VM test variant of the image once for what goes into it, and keeps
# each build for the VM tests to start from:
#
#   swiff-os/vm/build-image.sh selftest|sessiontest [--rebuild]
#
# prints the build's path without its extension: <path>.raw is the disk and
# <path>.efi the UKI. The build is keyed by its inputs: image/ (without its
# output, caches and private key), the profile's tree (vm/selftest/ or
# vm/sessiontest/), what image/stage.sh stages from the rest of the repository,
# and mkosi's version. With a stored build for the same inputs, mkosi does not
# run; any change to them builds again (--rebuild builds anyway). The builds
# are kept in $SWIFF_OS_BUILD_DIR/images (default ~/.cache/swiff-os/images),
# the newest three of each profile.
#
# The VM-only test Secure Boot key is made once for this PC, in
# $SWIFF_OS_BUILD_DIR/test-key, and copied into image/ when it has none: every
# worktree then signs alike, and reuses the others' builds. One build at a time
# on this PC: the next one waits.
#
# Needs: sudo (mkosi 20 builds as root), mkosi, the repository's npm
# dependencies (npm ci), openssl.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image_dir=$(cd "$here/../image" && pwd)
build_dir=${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}
out=$build_dir/output
store=$build_dir/images

die() {
	echo "build-image: $*" >&2
	exit 1
}

profile=${1:-}
case $profile in
selftest | sessiontest) ;;
*) die "usage: $0 selftest|sessiontest [--rebuild]" ;;
esac
rebuild=0
[ "${2:-}" = --rebuild ] && rebuild=1

mkdir -p "$out" "$build_dir/cache" "$store"
exec 7> "$build_dir/build.lock"
if ! flock -n 7; then
	echo "== waiting for another image build on this PC" >&2
	flock 7
fi

if [ ! -e "$image_dir/mkosi.key" ]; then
	keys=$build_dir/test-key
	if [ ! -e "$keys/mkosi.key" ]; then
		echo "== generating a VM-only test Secure Boot key in $keys" >&2
		# The private key is unencrypted (mkosi signs non-interactively), so it
		# is created readable by its owner only.
		(
			umask 077
			mkdir -p "$keys"
			openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
				-subj "/CN=Lanterel OS VM test Secure Boot key/" \
				-keyout "$keys/mkosi.key.new" -out "$keys/mkosi.crt" 2> /dev/null
			mv "$keys/mkosi.key.new" "$keys/mkosi.key"
		)
	fi
	(umask 077 && cp "$keys/mkosi.key" "$image_dir/mkosi.key")
	cp "$keys/mkosi.crt" "$image_dir/mkosi.crt"
fi

"$image_dir/stage.sh" "$out" >&2
key=$("$here/inputs-key.py" --with "$profile" --with "$(mkosi --version)" "$image_dir" "$here/$profile" "$out/stage")
base=$store/$profile-$key
if [ "$rebuild" = 1 ] || [ ! -e "$base.raw" ] || [ ! -e "$base.efi" ]; then
	echo "== building the $profile image (mkosi --profile=$profile), inputs $key" >&2
	sudo mkosi -C "$image_dir" --output-dir "$out" --cache-dir "$build_dir/cache" --profile="$profile" -f build >&2
	# Hard links: no copy, and mkosi replaces its outputs rather than writing into them.
	ln -f "$out/swiffos-$profile.raw" "$base.raw.new"
	ln -f "$out/swiffos-$profile.efi" "$base.efi"
	mv "$base.raw.new" "$base.raw"
	# The newest three builds of this profile stay.
	ls -t "$store/$profile"-*.raw | tail -n +4 | while read -r old; do rm -f "$old" "${old%.raw}.efi"; done
else
	echo "== the $profile image is up to date with its inputs ($key): not rebuilding" >&2
fi
touch "$base.raw"
echo "$base"
