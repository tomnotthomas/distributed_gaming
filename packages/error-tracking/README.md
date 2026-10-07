# @swiff/error-tracking

Error reports from the Lanterel apps that are not a web page, to PostHog's error
tracking: Lanterel Host (Electron, main process and window) and the Lanterel OS
services (swiff-hostd, swiff-streamer, swiff-steam-login). No SDK and no
dependencies: each report is one `$exception` event posted to PostHog's capture
API. The web app uses posthog-js instead (`web/src/posthog.ts`) and shares the
invite-link scrubbing from here.

## What a report holds

The error's type, message and stack, the error's causes, which program sent it
(`service`) and its version (`release`). Nothing about who: the distinct id is
random for each run and never stored, the event creates no person profile
(`$process_person_profile: false`) and asks for no location (`$geoip_disable`).
Every string goes through `scrub()` first (`src/scrub.ts`), which cuts invite
and seat links, credentials and long opaque strings, Steam IDs, e-mail and IP
addresses, and user names in file paths, plus any literal secret the program
names (its machine key, its machine id). The same failure is sent once per run,
and at most `MAX_REPORTS` per run.

## Configuration

Nothing is sent without a project key and host, and nothing when `DO_NOT_TRACK`
is set (to anything but `0`). Keys are never committed.

| Program       | Key                                                 | Host                              |
| ------------- | --------------------------------------------------- | --------------------------------- |
| Lanterel Host | `VITE_POSTHOG_KEY` at build time                    | `VITE_POSTHOG_HOST` at build time |
| Lanterel OS   | `LANTEREL_POSTHOG_KEY` in the service's environment | `LANTEREL_POSTHOG_HOST`           |

The host is the project's ingestion host, `https://eu.i.posthog.com` for
Lanterel's EU project, and must be https. The key is the project's public key
(`phc_...`), the same one the web app is built with.
