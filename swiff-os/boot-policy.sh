#!/usr/bin/env bash
# The signed boot policy for a released Swiff OS image set: which boots the
# server's TPM verifier accepts (server/src/boot-policy.ts). A person runs it on
# the machine that signs releases (the GEEKOM), after image-set.sh made the set:
#
#   swiff-os/boot-policy.sh <set-dir> <out-dir> [--iommu] [--previous <payload.json>]
#
# It checks the set as a release build would (signed by a release key in
# desktop/image-trust.json, with its certificate), takes shim, the boot loader
# and the UKI out of the set's ESP, checks their Secure Boot signatures with
# sbverify (shim against Microsoft's UEFI CA 2011 or 2023, the boot loader and
# the UKI against the set's swiffos-key.cer, as shim checks them), and computes
# the release's payload from
# them (npm run boot-policy -- payload: PCR 11 from the UKI, checked against
# the UKI's own signed .pcrsig; each binary's Authenticode digest, checked
# against its own signature; the PCR 7 authorities from the set's MOK and the
# Microsoft UEFI CAs in swiff-os/secure-boot/). With
# --previous, the releases of an earlier payload stay in it, so hosts still on
# them keep attesting; one of the same name is replaced.
#
# It shows the payload and asks before signing (run from a terminal: without
# one, or on no answer, it signs nothing), then signs it with the release
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
# Needs node, mtools, openssl, sbverify (sbsigntool) and the repository's npm
# dependencies.
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
[ -t 0 ] || die "run it from a terminal: it asks before signing"
for tool in node mcopy mdir openssl sbverify sbattach; do command -v "$tool" > /dev/null || die "$tool not found"; done
for f in image-signing-key.pem image-signing-key.passphrase; do
	[ -s "$KEYS/$f" ] || die "$KEYS/$f is missing"
done
[ -f "$set_dir/swiffos.json" ] || die "$set_dir is not an image set (no swiffos.json)"
for f in boot-policy.payload.json boot-policy.json boot-policy.pub.pem; do
	[ ! -e "$out/$f" ] || die "$out/$f is already there: a new policy goes into a new folder"
done

# 1. The set is a release's, as a release build of the host app reads it.
node "$repo/desktop/image-set.cjs" verify "$set_dir" || die "a release build would refuse $set_dir"
version=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$set_dir/swiffos.json")
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

# Each signed as Secure Boot will check it: shim by the firmware's db (one of
# Microsoft's UEFI CAs), the boot loader and the UKI by shim's MOK. sbverify
# checks the signature and that it is over the image; it trusts a chain that
# stops short of --cert, so openssl checks that the signer reaches the CA.
pem() { # <cert, PEM or DER> <out.pem>
	openssl x509 -in "$1" -out "$2" 2> /dev/null || openssl x509 -inform DER -in "$1" -out "$2"
}
signed_by() { # <efi> <CA file, PEM, one or more certificates>
	local sig=$work/sig.p7 certs=$work/sig-certs.pem serial cert
	rm -f "$sig" "$certs" "$work"/sig-cert-*.pem
	sbverify --cert "$2" "$1" > /dev/null 2>&1 || return 1
	sbattach --detach "$sig" "$1" > /dev/null 2>&1 || return 1
	openssl pkcs7 -inform DER -in "$sig" -print_certs -out "$certs" 2> /dev/null || return 1
	serial=$(openssl pkcs7 -inform DER -in "$sig" -print 2> /dev/null |
		sed -n 's/^ *serial: 0x0*\([0-9A-Fa-f]*\)$/\1/p' | head -n 1)
	[ -n "$serial" ] || return 1
	awk -v dir="$work" '/BEGIN CERT/ { n++ } n { print > (dir "/sig-cert-" n ".pem") }' "$certs"
	for cert in "$work"/sig-cert-*.pem; do
		[ -e "$cert" ] || continue
		[ "$(openssl x509 -in "$cert" -noout -serial | sed 's/^serial=0*//')" = "${serial^^}" ] || continue
		openssl verify -partial_chain -no_check_time -CAfile "$2" -untrusted "$certs" "$cert" > /dev/null 2>&1
		return
	done
	return 1
}
pem "$here/secure-boot/microsoft-uefi-ca-2011.der" "$work/ca-2011.pem"
pem "$here/secure-boot/microsoft-uefi-ca-2023.der" "$work/ca-2023.pem"
pem "$set_dir/swiffos-key.cer" "$work/mok.pem"
signed_by "$work/shimx64.efi" "$work/ca-2011.pem" || signed_by "$work/shimx64.efi" "$work/ca-2023.pem" ||
	die "shim is not signed by Microsoft's UEFI CA 2011 or 2023"
signed_by "$work/grubx64.efi" "$work/mok.pem" || die "the boot loader is not signed by the set's swiffos-key.cer"
signed_by "$work/uki.efi" "$work/mok.pem" || die "the UKI is not signed by the set's swiffos-key.cer"

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
answer=
read -rp "Sign this boot policy with $KEYS/image-signing-key.pem? [y/N] " answer || true
[ "$answer" = y ] || [ "$answer" = Y ] || die "not signed"

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
