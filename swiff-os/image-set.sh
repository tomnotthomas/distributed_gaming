#!/usr/bin/env bash
# Swiff OS's image set: what the host app's installer writes to a PC
# (desktop/image-set.cjs), made from an mkosi build.
#
#   swiff-os/image-set.sh <build-output> <image-name> <out-dir>
#
# <image-name> is the build's name: swiffos for the shipped image,
# swiffos-selftest for the test build. The set is:
#
#   swiffos_<version>.esp.raw    the build's ESP files on a FAT32 with 512-byte
#                                sectors (below), plus \EFI\swiff\ for real PCs:
#                                Ubuntu's shim (shimx64.efi, signed by
#                                Microsoft's 3rd-party UEFI CA), MokManager
#                                (mmx64.efi), and the build's own signed
#                                systemd-boot as grubx64.efi, the name shim
#                                starts. \EFI\BOOT\BOOTX64.EFI stays the build's
#                                systemd-boot, for VMs that trust Swiff's key in db.
#   swiffos_<version>.root-x86-64.raw, .root-x86-64-verity.raw
#   swiffos-key.cer              the certificate that signed systemd-boot and
#                                the UKI (from the ESP's db.auth): the MOK
#   swiffos.json                 the layout, and each file's size and SHA-256
#   swiffos.json.sig             its Ed25519 signature: the app reads no
#                                manifest that a key it trusts did not sign
#
# The release signs with the private key in the file $SWIFF_OS_SIGNING_KEY,
# which the release step writes from its secret store: it is never in the
# repository. The app ships the release key's public half, with the SHA-256 of
# the certificate its sets carry, in desktop/image-trust.json: the entry
# `node desktop/image-set.cjs trust <key> <swiffos-key.cer>` prints. Without
# $SWIFF_OS_SIGNING_KEY the set is signed with this developer's own key,
# made once in ${XDG_CONFIG_HOME:-~/.config}/swiff/image-dev-key.pem, and its
# entry is written to desktop/image-trust.dev.json, which only a test build
# (`npm run pack:test` in desktop/) and the VM tests' console installer trust.
# Either key file is kept encrypted, never as a plain PEM: its passphrase comes
# from $SWIFF_OS_KEY_PASSPHRASE (the release's secret store, or asked for here
# on a terminal), and a key file that is not encrypted is refused.
#
# Ubuntu's shim comes from the image's own pinned archive snapshot
# (shim-signed, checked against SHIM_SHA256 below), or from $SHIM_DIR (a
# folder with shimx64.efi.signed.latest and mmx64.efi).
#
# The build's ESP has 4,096-byte sectors (systemd-repart's). Windows misreads
# such a FAT on a disk with 512-byte sectors, as nearly every PC's is, and its
# chkdsk "repairs" it into one no firmware can read: the VM test caught it. So
# the set's ESP holds the same files, label and serial on a FAT32 with
# 512-byte sectors, as every dual-boot Linux ESP has, and the installer offers
# only disks with 512-byte sectors.
#
# Needs node, mtools, mkfs.fat and curl or $SHIM_DIR. Writes only into <out-dir>,
# and with the developer's key into its folder and desktop/image-trust.dev.json.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
desktop=$here/../desktop
[ $# -eq 3 ] || {
	echo "usage: image-set.sh <build-output> <image-name> <out-dir>" >&2
	exit 2
}
build=$1 name=$2 out=$3
# The archive snapshot the image is built from (Mirror= in image/mkosi.conf), and its shim-signed.
mirror=$(sed -n 's/^Mirror=//p' "$here/image/mkosi.conf")
shim_deb=pool/main/s/shim-signed/shim-signed_1.59+15.8-0ubuntu2_amd64.deb
SHIM_SHA256=f8ed71ce2d91a304b6d5eb84997f846f331b554578bc02dbfe78e13ad8ac81a9

die() {
	echo "image-set: $*" >&2
	exit 1
}
for tool in node mcopy mmd minfo; do command -v "$tool" > /dev/null || die "$tool not found"; done
key=${SWIFF_OS_SIGNING_KEY:-}
[ -n "$key" ] || key=${XDG_CONFIG_HOME:-$HOME/.config}/swiff/image-dev-key.pem
if [ -z "${SWIFF_OS_KEY_PASSPHRASE:-}" ] && [ -t 0 ]; then
	read -rsp "Passphrase of the image signing key: " SWIFF_OS_KEY_PASSPHRASE
	echo
	if [ -z "${SWIFF_OS_SIGNING_KEY:-}" ] && [ ! -e "$key" ]; then
		read -rsp "The same passphrase again, for the new key: " again
		echo
		[ "$again" = "$SWIFF_OS_KEY_PASSPHRASE" ] || die "the two passphrases differ: no key was made"
	fi
fi
[ -n "${SWIFF_OS_KEY_PASSPHRASE:-}" ] || die "set SWIFF_OS_KEY_PASSPHRASE to the image signing key's passphrase"
export SWIFF_OS_KEY_PASSPHRASE
mkfs_fat=$(command -v mkfs.fat || echo /usr/sbin/mkfs.fat)
[ -x "$mkfs_fat" ] || die "mkfs.fat not found"
[ -e "$build/$name.raw" ] || die "$build/$name.raw not found: build the image first"
version=$(node -e 'console.log(require(process.argv[1]).SWIFF_OS.version)' "$desktop/rental.cjs")
# The key must unlock before the long build, not after it: a new developer key is made first.
[ -n "${SWIFF_OS_SIGNING_KEY:-}" ] || [ -e "$key" ] || node "$desktop/image-set.cjs" devkey "$key"
node "$desktop/image-set.cjs" trust "$key" /dev/null > /dev/null
export MTOOLS_SKIP_CHECK=1

mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

shim=${SHIM_DIR:-}
if [ -z "$shim" ]; then
	curl -fsSL -o "$work/shim.deb" "$mirror/$shim_deb"
	echo "$SHIM_SHA256  $work/shim.deb" | sha256sum -c --quiet || die "shim-signed's SHA-256 is not the pinned one"
	mkdir "$work/shim" && dpkg-deb -x "$work/shim.deb" "$work/shim"
	shim=$work/shim/usr/lib/shim
fi

build_esp=$build/$name.esp.raw
esp=$out/swiffos_$version.esp.raw
serial=$(minfo -i "$build_esp" :: | sed -n 's/^.*serial number: \([0-9A-Fa-f]*\).*$/\1/p' | head -n1)
label=$(minfo -i "$build_esp" :: | sed -n 's/^.*disk label="\([^"]*\)".*$/\1/p' | head -n1 | sed 's/ *$//')
[ -n "$serial" ] || die "no volume serial in $build_esp"
mkdir "$work/files"
mcopy -s -m -i "$build_esp" "::/*" "$work/files/"
rm -f "$esp"
truncate -s "$(stat -c %s "$build_esp")" "$esp"
# 4 KiB clusters, as the build's: 262,144 of them in 1 GiB, well inside FAT32's range.
"$mkfs_fat" -F 32 -S 512 -s 8 -n "${label:-ESP}" -i "$serial" "$esp" > /dev/null
mcopy -s -m -i "$esp" "$work/files/"* ::/
mcopy -o -i "$esp" ::/EFI/systemd/systemd-bootx64.efi "$work/systemd-boot.efi"
mmd -i "$esp" ::/EFI/swiff
mcopy -o -i "$esp" "$shim/shimx64.efi.signed.latest" ::/EFI/swiff/shimx64.efi
mcopy -o -i "$esp" "$shim/mmx64.efi" ::/EFI/swiff/mmx64.efi
mcopy -o -i "$esp" "$work/systemd-boot.efi" ::/EFI/swiff/grubx64.efi
mcopy -o -i "$esp" ::/loader/keys/auto/db.auth "$work/db.auth"
node "$desktop/image-set.cjs" cert "$work/db.auth" "$out/swiffos-key.cer"
for split in root-x86-64 root-x86-64-verity; do
	cp --sparse=always "$build/$name.$split.raw" "$out/swiffos_$version.$split.raw"
done
node "$desktop/image-set.cjs" manifest "$out" "$build/$name.raw" "$version"
if [ -z "${SWIFF_OS_SIGNING_KEY:-}" ]; then
	# Into place only when it succeeds: a failed run keeps the trusted entry there was.
	node "$desktop/image-set.cjs" trust "$key" "$out/swiffos-key.cer" > "$work/image-trust.dev.json"
	mv "$work/image-trust.dev.json" "$desktop/image-trust.dev.json"
fi
node "$desktop/image-set.cjs" sign "$out" "$key"
echo "Swiff OS $version image set in $out"
