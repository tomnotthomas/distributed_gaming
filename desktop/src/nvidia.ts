// What the Rental mode screen says about installing NVIDIA's driver: Swiff's
// hosting terms for NVIDIA cards, and each way the install can fail, with what
// the owner does next. The driver itself comes from Ubuntu (nvidia.cjs).

import type { NvidiaError } from "../nvidia.cjs";

/**
 * Swiff's hosting terms for NVIDIA cards, which the owner accepts beside
 * NVIDIA's licence. nvidia.cjs TERMS_VERSION names this text: change both
 * together, and owners are asked again.
 *
 * LEGAL REVIEW: draft wording, to be checked by counsel before hosting opens
 * to strangers. Written to hold for an EU consumer: the cost cover is limited
 * to the owner's own fault and leaves their statutory rights alone, since a
 * broad indemnity from a consumer would not stand (swiff-os/NVIDIA.md, Licence).
 */
export const NVIDIA_TERMS: readonly string[] = [
  "You install NVIDIA's driver yourself, from Ubuntu, and accept NVIDIA's licence for it with NVIDIA. Swiff does not supply, sell or license NVIDIA's software.",
  "This PC and its graphics card are yours, the PC stands in your home, and you host as a private person: not from a data centre, and not as a business.",
  "You hold the licences this PC needs to host, NVIDIA's included.",
  "If you break these terms and someone, NVIDIA included, holds Swiff liable for it, you cover Swiff's reasonable costs from it, unless you were not at fault. Your rights as a consumer under the law stay as they are.",
  "Swiff can pause hosting on NVIDIA cards at any time, for everyone. You can stop hosting and remove the driver whenever you like.",
];

/** "355 MB": megabytes as Explorer counts them. */
export const mb = (bytes: number): string => `${Math.round(bytes / 1024 ** 2)} MB`;

/** What went wrong, and what to do next, in one or two sentences. `letter` is the games drive's. */
export function nvidiaFailure(error: NvidiaError, letter: string, bytes: number): string {
  switch (error) {
    case "offline":
      return "Swiff could not reach Ubuntu's server. Check this PC's internet connection, then try again: what has downloaded is kept.";
    case "gone":
      return "Ubuntu's server no longer has this release of NVIDIA's driver. A Swiff Host update brings the current one.";
    case "server":
      return "Ubuntu's server did not answer properly, which happens when it is busy. Try again in a few minutes.";
    case "changed":
      return "What Ubuntu's server sent is not NVIDIA's driver as Swiff OS expects it, so it was not kept. Try again; if it happens again, a Swiff Host update is needed.";
    case "space":
      return `${letter}: needs ${mb(bytes)} free for NVIDIA's driver. Free up space there, then try again.`;
    case "write":
      return `Swiff could not write to ${letter}:. Check that the drive is connected and not read-only, then try again.`;
    case "cancelled":
      return "Stopped. What has downloaded is kept: installing again picks up from there.";
  }
}

/** Why NVIDIA's licence did not load. */
export function licenceFailure(error: NvidiaError): string {
  return error === "changed"
    ? "The licence Ubuntu's server sent is not the one for this driver, so it is not shown. Try again later; if it happens again, a Swiff Host update is needed."
    : "Swiff could not load NVIDIA's licence from Ubuntu. Check this PC's internet connection, then try again.";
}
