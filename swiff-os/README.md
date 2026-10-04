# Swiff OS

The rental-mode boot system for host PCs: an immutable Linux image that runs Steam in a
gamescope session for one renter at a time. It is measured into the TPM and attested by the
Swiff server before any renter is sent to it. It is built in stages, each a small PR.

## Server: hosting requires attestation

The server side lives in `server/`, not here: `server/src/attestation.ts`. A machine's rights
are split in two. The machine key, which stays in the owner's host app, keeps the control
rights. A short-lived host certificate, which `swiff-hostd` earns by attestation, gets the
hosting rights: `session-claimed`, session keys and TURN credentials.

`HOSTING_ATTESTATION=required` switches an environment to attested-only hosting. The default,
`optional`, keeps today's desktop hosts working at an explicit `unattested` tier. The verifier
is an interface; only the `insecure-dev` stub exists yet. The contract is in
[`docs/system-design/session-keys.md`](../docs/system-design/session-keys.md), "Control and
hosting credentials".

## Host app: preflight, install and switch

The owner's side lives in `desktop/`: `desktop/rental.cjs` reads, without administrator
rights, what Swiff OS needs from the PC (UEFI, Secure Boot, TPM 2.0, IOMMU, disk space,
BitLocker, graphics card, Fast Startup), and the Rental mode screen
(`desktop/src/screens/Rental.tsx`) shows it with the BIOS steps the owner must take by hand.
The Secure Boot db and the TPM's endorsement certificate need administrator rights, so they
show as not checked yet. The install (shrink a drive or use free space, add the partitions,
write the ESP, add the boot entry, name the games drive `SWIFFGAMES`) and the start/stop
sharing switch (BootOrder and BootNext) are previews: the app plans them and runs nothing on
a PC. `desktop/vm/rental-install-test.sh` carries the plans out on a disk image and boots it
under OVMF with Secure Boot and a software TPM.
