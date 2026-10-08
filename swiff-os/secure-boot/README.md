# Secure Boot certificates the boot policy names

The db certificates a PC's firmware may verify Swiff OS's shim with. `swiff-os/boot-policy.sh`
passes them to the boot policy generator (`server/src/release-policy.ts`), which lists the PCR 7
authority each one makes when the firmware verifies shim (or a GPU's option ROM) with it. Each
is Microsoft's, as Microsoft publishes it (DER):

| File                                    | Certificate                        | SHA-256                                                            | Source                                             |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `microsoft-uefi-ca-2011.der`            | Microsoft Corporation UEFI CA 2011 | `48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507` | `https://go.microsoft.com/fwlink/p/?linkid=321194` |
| `microsoft-uefi-ca-2023.der`            | Microsoft UEFI CA 2023             | `f6124e34125bee3fe6d79a574eaa7b91c0e7bd9d929c1a321178efd611dad901` | `https://go.microsoft.com/fwlink/?linkid=2239872`  |
| `microsoft-option-rom-uefi-ca-2023.der` | Microsoft Option ROM UEFI CA 2023  | `e5be3e64c6e66a281457ecdece0d6d0787577aad2a3a0144262c10c14ba8d8f1` | `https://go.microsoft.com/fwlink/?linkid=2284009`  |

Ubuntu's shim 15.8, which the image set ships, is signed by the 2011 CA; a shim signed by the
2023 CA verifies against that one. On a real PC's TCG log, the firmware's authority for the
2011 CA is `4d4a8e2c74133bbdc01a16eaf2dbb5d575afeb36f5d8dfcf609ae043909e2ee9`, the value the
generator computes (`server/src/test/release-policy.test.ts`).
