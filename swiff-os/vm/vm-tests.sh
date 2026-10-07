#!/usr/bin/env bash
# Runs the VM tests a change touches, one after the other, and times each:
#
#   swiff-os/vm/vm-tests.sh [--base REF] [--only SUITE,...] [--list] [--no-build|--rebuild]
#
# The suites:
#   selftest  swiff-os/vm/run-test.sh                Lanterel OS's self-test, 12 boots
#   session   swiff-os/vm/session-test.sh            a renter's session, end to end
#   streamer  swiff-os/streamer/vm/run-test.sh       the streamer in a VM of its own
#   rental    desktop/vm/rental-install-test.sh      install and switch on a Windows-like disk
#   mok       desktop/vm/mok-enroll-test.sh          MokManager's confirmation
#   windows   desktop/vm/windows-install-test.sh test   the installer on real Windows
#             (only once a Windows base is prepared; $SWIFF_SCENARIOS picks its scenarios)
#
# Without --only, the suites are those the files changed since REF touch
# (default: where this branch left origin/main), the working tree's changes and
# new files included. --list prints them and runs nothing. --no-build and
# --rebuild go to the suites that build an image. It exits non-zero when a
# suite fails; on a PC others share, run it as one heavy job:
# flock /tmp/swiff-heavy.lock swiff-os/vm/vm-tests.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
all="selftest session streamer rental mok windows"

base=
only=
list=0
build_arg=
while [ $# -gt 0 ]; do
	case $1 in
	--base) base=${2:?--base needs a ref}; shift ;;
	--only) only=${2:?--only needs suites}; shift ;;
	--list) list=1 ;;
	--no-build | --rebuild) build_arg=$1 ;;
	*)
		echo "usage: $0 [--base REF] [--only SUITE,...] [--list] [--no-build|--rebuild]" >&2
		exit 2
		;;
	esac
	shift
done

# The suites a changed file touches.
suites_for() { # path
	case $1 in
	*.md | *.test.ts | *.test.tsx) ;;
	swiff-os/vm/vm-run.py | swiff-os/vm/vm-tests.sh) echo "$all" ;;
	swiff-os/vm/build-image.sh | swiff-os/vm/inputs-key.py) echo selftest session streamer ;;
	swiff-os/image/*) echo selftest session rental windows ;;
	swiff-os/hostd/* | swiff-os/steam/*) echo selftest session ;;
	swiff-os/image-set.sh) echo rental windows ;;
	swiff-os/vm/sessiontest/* | swiff-os/vm/session-*) echo session ;;
	swiff-os/vm/*) echo selftest ;;
	swiff-os/streamer/vm/*) echo streamer ;;
	swiff-os/streamer/*) echo selftest session streamer ;;
	server/* | web/* | packages/*) echo session streamer ;;
	desktop/vm/mok-* | desktop/vm/boot-vars.py | desktop/vm/apply-plan.cjs) echo rental mok ;;
	desktop/vm/rental-*) echo rental ;;
	desktop/vm/*) echo windows ;;
	desktop/rental.cjs) echo rental mok windows ;;
	desktop/*.cjs) echo rental windows ;;
	esac
}

if [ -n "$only" ]; then
	wanted=" ${only//,/ } "
	for s in $wanted; do
		[[ " $all " == *" $s "* ]] || { echo "vm-tests: no suite $s (suites: $all)" >&2; exit 2; }
	done
else
	if [ -z "$base" ]; then
		base=$(git -C "$repo" merge-base origin/main HEAD 2> /dev/null) ||
			{ echo "vm-tests: no origin/main to compare with: pass --base REF or --only" >&2; exit 2; }
	fi
	wanted=" "
	while read -r path; do
		for s in $(suites_for "$path"); do
			[[ "$wanted" == *" $s "* ]] || wanted="$wanted$s "
		done
	done < <(git -C "$repo" diff --name-only "$base" -- && git -C "$repo" ls-files --others --exclude-standard)
fi
# In the suites' own order.
suites=
for s in $all; do [[ "$wanted" == *" $s "* ]] && suites="$suites $s"; done
suites=${suites# }
if [ -z "$suites" ]; then
	echo "vm-tests: no VM test touched"
	exit 0
fi
echo "vm-tests: $suites"
[ "$list" = 0 ] || exit 0

results=()
fail=0
for s in $suites; do
	case $s in
	selftest) cmd=("$here/run-test.sh" $build_arg) ;;
	session) cmd=("$here/session-test.sh" $build_arg) ;;
	streamer) cmd=("$repo/swiff-os/streamer/vm/run-test.sh" $build_arg) ;;
	rental) cmd=("$repo/desktop/vm/rental-install-test.sh") ;;
	mok) cmd=("$repo/desktop/vm/mok-enroll-test.sh") ;;
	windows)
		win=${SWIFF_WIN_VM_DIR:-${SWIFF_OS_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/swiff-os}/win-vm}
		if [ ! -e "$win/base.ready" ]; then
			results+=("SKIP  windows   no prepared Windows base (desktop/vm/windows-install-test.sh prepare)")
			continue
		fi
		cmd=("$repo/desktop/vm/windows-install-test.sh" test)
		;;
	esac
	printf '\n==== %s: %s\n' "$s" "${cmd[*]}"
	start=$SECONDS
	if "${cmd[@]}"; then status=PASS; else status=FAIL fail=1; fi
	results+=("$(printf '%-4s  %-9s %ds' "$status" "$s" $((SECONDS - start)))")
done

printf '\n==== VM tests\n'
printf '%s\n' "${results[@]}"
exit "$fail"
