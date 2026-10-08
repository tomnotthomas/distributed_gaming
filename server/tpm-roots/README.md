# TPM vendor roots

The certificate authorities the production attestation verifier (`ATTESTATION_VERIFIER=tpm`)
checks a machine's EK certificate against (`server/src/ek.ts`). A machine whose EK certificate
does not chain to one of them cannot attest. The server takes this folder when
`ATTESTATION_TPM_ROOTS` is unset.

| Folder      | Vendor (file)                                               | TPM kind     |
| ----------- | ----------------------------------------------------------- | ------------ |
| `firmware/` | AMD (`amd.pem`): fTPM and AMD's Pluton                      | firmware TPM |
| `firmware/` | Intel (`intel.pem`): PTT                                    | firmware TPM |
| `discrete/` | Infineon, STMicro, Nuvoton, NationZ, Atmel (`<vendor>.pem`) | TPM chip     |

Each file holds the vendor's roots and the intermediates that chain to them, as PEM, each
preceded by comment lines: its subject, issuer, validity, SHA-256 fingerprint and where it came
from. `manifest.json` lists the same certificates with their fingerprints, and every certificate
the import left out, with the reason. `server/src/test/tpm-roots.test.ts` checks that the files
and the manifest agree, that every intermediate chains to a root here, and that no CA issuing
Windows' AIK certificates is among them.

## Where they come from

- **Microsoft's `TrustedTpm.cab`**
  (`https://go.microsoft.com/fwlink/?linkid=2097925`, served by `download.microsoft.com` over
  HTTPS): the TPM vendors' EK roots and intermediates that Windows trusts, which Microsoft
  collects from each vendor. The manifest records the cab's SHA-256 and its date.
- **AMD's two fTPM roots** (`CN=AMDTPM`, RSA and ECC), which the cab lacks although it carries
  the per-CPU-family intermediates they sign: from `https://ftpm.amd.com/pki/aia/`, the address
  those intermediates name as their issuer, pinned in the script by SHA-256
  (`67bd2472…c6a1` RSA, `14aac9fd…4f9d` ECC). Each is kept only because it signed intermediates
  that came in the cab. Without them no AMD fTPM (Ryzen) can attest.

Left out, on purpose:

- the cab's `Microsoft/` folder: the CAs under Microsoft TPM Root Certificate Authority 2014
  issue Windows' **AIK** certificates, not EK certificates. An AIK certificate must never pass
  as an EK's.
- the cab's `QC/` folder: Qualcomm's Arm SoCs, which Swiff OS does not run on.
- certificates OpenSSL will not parse (STMicro's oldest intermediates are not DER; their
  reissued `_2` versions are kept), ones that are not CAs or not valid now, and intermediates
  that chain to no root kept here (Infineon's TPM 1.2-era `IFX TPM EK Intermediate CA`s, whose
  own root is gone).

An EK certificate that chains only through one of those is refused as `ek-untrusted`.

## Refreshing

Microsoft updates the cab every few months, and a new CPU family brings new intermediates. To
refresh (needs `cabextract` and network access):

```sh
curl -L -o TrustedTpm.cab 'https://go.microsoft.com/fwlink/?linkid=2097925'
node server/scripts/tpm-roots.mjs TrustedTpm.cab
```

It rewrites this folder and prints each certificate added (`+`) or gone (`-`) by fingerprint.
Review that diff before committing: a new root is a new vendor or key the server will trust.
To check a real machine's EK certificate against the store without committing it (an EK
certificate identifies one PC), run the server's tests with `TPM_REAL_EK_CERT=<file>`.
