#!/usr/bin/env bash
# The signed boot policy for a released Swiff OS image set: which boots the
# server's TPM verifier accepts (server/src/boot-policy.ts). A person runs it on
# the machine that signs releases (the GEEKOM), after image-set.sh made the set:
#
#   swiff-os/boot-policy.sh <set-dir> <out-dir> [--iommu] [--previous <payload.json>]
#
# It checks the set as a release build would (signed by a release key in
# desktop/image-trust.json, with its certificate), takes shim, the boot loader
# and the UKI out of the set's ESP, and computes the release's payload from
# them (npm run boot-policy -- payload: PCR 11 from the UKI, checked against
# the UKI's own signed .pcrsig; each binary's Authenticode digest, checked
# against its own signature; the PCR 7 authorities from the set's MOK, the
# Microsoft UEFI CAs in swiff-os/secure-boot/ and shim's SbatLevels). With
# --previous, the releases of an earlier payload stay in it, so hosts still on
# them keep attesting; one of the same name is replaced.
#
# It shows the payload, asks before signing, then signs it with the release
# image signing key and writes into <out-dir>:
#
#   boot-policy.payload.json  what was signed: keep it for the next --previous
#   boot-policy.json          the signed policy: the server's ATTESTATION_POLICY
#   boot-policy.pub.pem       the key's public half: ATTESTATION_POLICY_KEY
#
# and reads the policy back as the server will. --iommu is only for a release
# that will not reach systemd's `ready` phase without DMA remapping on.
#
# It reads the release key only by path, and its passphrase file only into
# $SWIFF_OS_KEY_PASSPHRASE for the signing step; it never prints, copies or logs
# either (no `set -x`).
#
# Environment (optional):
#   KEYS  the release key folder (default: ~/.lanterel-keys/release)
#
# Needs node, mtools and the repository's npm dependencies.
set -euo pipefail
set +x

here=$(cd "$(dirname "$0")" && pwd)
repo=$here/..
KEYS=${KEYS:-$HOME/.lanterel-keys/release}
die() {
	echo "boot-policy: $*" >&2
	exit 1
}
usage() {
	echo "usage: boot-policy.sh <set-dir> <out-dir> [--iommu] [--previous <payload.json>]" >&2
	exit 2
}
[ $# -ge 2 ] || usage
set_dir=$1 out=$2
shift 2
extra=()
while [ $# -gt 0 ]; do
	case $1 in
	--iommu) extra+=(--iommu) ;;
	--previous)
		[ $# -ge 2 ] || usage
		[ -f "$2" ] || die "$2 does not exist"
		extra+=(--previous "$2")
		shift
		;;
	*) usage ;;
	esac
	shift
done
for tool in node mcopy mdir; do command -v "$tool" > /dev/null || die "$tool not found"; done
for f in image-signing-key.pem image-signing-key.passphrase; do
	[ -s "$KEYS/$f" ] || die "$KEYS/$f is missing"
done
[ -f "$set_dir/swiffos.json" ] || die "$set_dir is not an image set (no swiffos.json)"
for f in boot-policy.payload.json boot-policy.json boot-policy.pub.pem; do
	[ ! -e "$out/$f" ] || die "$out/$f is already there: a new policy goes into a new folder"
done

# 1. The set is a release's, as a release build of the host app reads it.
node "$repo/desktop/image-set.cjs" verify "$set_dir" || die "a release build would refuse $set_dir"
version=$(node -e 'console.log(require(process.argv[1]).version)' "$set_dir/swiffos.json")
esp=$set_dir/swiffos_$version.esp.raw
[ -f "$esp" ] || die "$esp not found"

# 2. Its boot chain, out of its ESP: shim, systemd-boot as shim starts it, the UKI.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export MTOOLS_SKIP_CHECK=1
mcopy -n -i "$esp" ::/EFI/swiff/shimx64.efi ::/EFI/swiff/grubx64.efi "$work/"
mapfile -t ukis < <(mdir -b -i "$esp" ::/EFI/Linux/ | sed -n 's|^::/EFI/Linux/\(.*\.efi\)$|\1|ip')
[ ${#ukis[@]} -eq 1 ] || die "the ESP should hold one UKI in \\EFI\\Linux, not ${#ukis[@]}"
mcopy -n -i "$esp" "::/EFI/Linux/${ukis[0]}" "$work/uki.efi"

# 3. The payload.
(cd "$repo" && npm run --silent build -w @swiff/server > /dev/null) || die "the server did not build"
cli=$repo/server/dist/cli.js
mkdir -p "$out"
node "$cli" boot-policy payload --name "swiffos $version" \
	--shim "$work/shimx64.efi" --boot-loader "$work/grubx64.efi" --uki "$work/uki.efi" \
	--mok "$set_dir/swiffos-key.cer" \
	--db-cert "$here/secure-boot/microsoft-uefi-ca-2011.der" \
	--db-cert "$here/secure-boot/microsoft-uefi-ca-2023.der" \
	--db-cert "$here/secure-boot/microsoft-option-rom-uefi-ca-2023.der" \
	"${extra[@]}" > "$work/payload.json"
cat "$work/payload.json"
if [ -t 0 ]; then
	read -rp "Sign this boot policy with $KEYS/image-signing-key.pem? [y/N] " answer
	[ "$answer" = y ] || [ "$answer" = Y ] || die "not signed"
fi

# 4. Signed with the release image signing key; its public half is the one desktop/image-trust.json lists.
(
	SWIFF_OS_KEY_PASSPHRASE=$(cat "$KEYS/image-signing-key.passphrase")
	export SWIFF_OS_KEY_PASSPHRASE
	node "$cli" boot-policy "$work/payload.json" "$KEYS/image-signing-key.pem" > "$work/boot-policy.json"
	node -e '
		const { createPrivateKey, createPublicKey } = require("node:crypto");
		const fs = require("node:fs");
		const key = createPrivateKey({ key: fs.readFileSync(process.argv[1], "utf8"), passphrase: process.env.SWIFF_OS_KEY_PASSPHRASE });
		process.stdout.write(createPublicKey(key).export({ type: "spki", format: "pem" }));
	' "$KEYS/image-signing-key.pem" > "$work/boot-policy.pub.pem"
)
node -e '
	const { createPublicKey } = require("node:crypto");
	const fs = require("node:fs");
	const der = (pem) => createPublicKey(pem).export({ type: "spki", format: "der" });
	const mine = der(fs.readFileSync(process.argv[1], "utf8"));
	const trusted = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
	if (!trusted.some((entry) => der(entry.publicKey).equals(mine))) {
		console.error("boot-policy: the signing key is not one desktop/image-trust.json lists");
		process.exit(1);
	}
' "$work/boot-policy.pub.pem" "$repo/desktop/image-trust.json"

# 5. Read back as the server reads it.
node --input-type=module -e '
	import { readFileSync } from "node:fs";
	const { readBootPolicy } = await import(process.argv[1]);
	const policy = readBootPolicy(readFileSync(process.argv[2], "utf8"), readFileSync(process.argv[3], "utf8"));
	console.log(`boot-policy: signed for ${policy.releases.map((r) => r.name).join(", ")}`);
' "$repo/server/dist/boot-policy.js" "$work/boot-policy.json" "$work/boot-policy.pub.pem"

cp "$work/payload.json" "$out/boot-policy.payload.json"
cp "$work/boot-policy.json" "$work/boot-policy.pub.pem" "$out/"
echo "Boot policy in $out: deploy boot-policy.json as ATTESTATION_POLICY and boot-policy.pub.pem as ATTESTATION_POLICY_KEY."
