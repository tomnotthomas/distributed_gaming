#!/usr/bin/env bash
# Lanterel's release keys, made once on the machine that signs releases (the
# GEEKOM), and again at each rotation (README, "Release keys"):
#
#   swiff-os/release-key.sh <key-dir> <backup-file>
#
# Into <key-dir> (made 0700; every file 0600 but public.txt):
#
#   image-signing-key.pem         the Ed25519 key that signs each image set's
#                                 manifest (image-set.cjs devkey: PKCS#8,
#                                 AES-256), the release's $SWIFF_OS_SIGNING_KEY
#   image-signing-key.passphrase  what unlocks it: $SWIFF_OS_KEY_PASSPHRASE
#   secure-boot.key, .crt         the Secure Boot key pair that signs systemd-boot,
#                                 the UKI and its expected PCR values, as `mkosi
#                                 genkey` makes one (RSA-2048, self-signed); the
#                                 certificate is the MOK each host enrols. The
#                                 key is not encrypted: mkosi signs without asking.
#   backup.passphrase             what unlocks <backup-file>, and nothing else:
#                                 to be moved offline
#   public.txt                    the public halves and their fingerprints, as
#                                 printed: `node desktop/image-set.cjs add-trust
#                                 <key-dir>/public.txt` puts them into
#                                 desktop/image-trust.json
#
# <backup-file> holds both keys and the image key's passphrase, encrypted with
# gpg (symmetric, AES-256) under backup.passphrase. Nothing secret is printed,
# and nothing is made over an existing key.
#
# Needs node, openssl, gpg and tar.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
image_set=$here/../desktop/image-set.cjs
die() {
	echo "release-key: $*" >&2
	exit 1
}
[ $# -eq 2 ] || {
	echo "usage: release-key.sh <key-dir> <backup-file>" >&2
	exit 2
}
dir=$1 backup=$2
for tool in node openssl gpg tar; do command -v "$tool" > /dev/null || die "$tool not found"; done
for name in image-signing-key.pem image-signing-key.passphrase secure-boot.key secure-boot.crt backup.passphrase; do
	[ ! -e "$dir/$name" ] || die "$dir/$name is already there: a new key pair goes into a new folder"
done
[ ! -e "$backup" ] || die "$backup is already there"

mkdir -p "$dir" "$(dirname "$backup")"
chmod 700 "$dir"
openssl rand -base64 33 | tr -d '\n' > "$dir/image-signing-key.passphrase"
openssl rand -base64 33 | tr -d '\n' > "$dir/backup.passphrase"
SWIFF_OS_KEY_PASSPHRASE=$(cat "$dir/image-signing-key.passphrase")
export SWIFF_OS_KEY_PASSPHRASE
node "$image_set" devkey "$dir/image-signing-key.pem"
openssl req -new -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
	-subj "/CN=Lanterel OS Secure Boot/O=Lanterel/" \
	-keyout "$dir/secure-boot.key" -out "$dir/secure-boot.crt" 2> /dev/null
tar -C "$dir" -cf - image-signing-key.pem image-signing-key.passphrase secure-boot.key secure-boot.crt |
	gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$dir/backup.passphrase" \
		--symmetric --cipher-algo AES256 -o "$backup"
node "$image_set" public "$dir/image-signing-key.pem" "$dir/secure-boot.crt" > "$dir/public.txt"
chmod 600 "$dir"/* "$backup"
chmod 644 "$dir/public.txt"
cat "$dir/public.txt"
echo "Keys in $dir, encrypted backup in $backup; move $dir/backup.passphrase offline."
