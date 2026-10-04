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
