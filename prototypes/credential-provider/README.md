# Swiff credential provider

Logs the throwaway session account in at the sign-in screen, with no reboot and without the owner
ever choosing an account.

## Why this exists

The renter needs a **real Windows session** — that is the only way to get DWM, the real GPU and
exclusive fullscreen. Everything cheaper was measured and ruled out in
[`../isolation-proof`](../isolation-proof/README.md):

| Tried | Result |
|---|---|
| Second desktop in the owner's session | Chromium started 7 processes and drew **nothing**. No DWM, no composition target. |
| RDP to loopback, then `tscon` to console | Windows refuses: *"you already have a console session in progress"*. |
| AutoAdminLogon | Works, but costs a reboot per session. |

A real logon only ever happens through the sign-in screen, and the sign-in screen cannot be
scripted — deliberately, or malware could log in as anyone. The one supported way to put
credentials into it is to write a plugin for it. That plugin is a credential provider.

## How it works

```
host app  ->  Write-Ticket.ps1        one-shot ticket, DPAPI machine scope, HKLM, SYSTEM+Admins only
          ->  WTSDisconnectSession    owner's session detaches; console falls to LogonUI
              LogonUI loads SwiffCP.dll
              SetUsageScenario   -> consumes the ticket and DELETES it
              GetCredentialCount -> 1 credential, pbAutoLogonWithDefault = TRUE
              GetSerialization   -> packed KERB_INTERACTIVE_UNLOCK_LOGON
          ->  renter session on the console, full GPU + DWM
```

The owner sees: click, screen goes dark for a few seconds, renter session live. Getting the machine
back costs one password entry, which is just unlocking their own PC.

## The safety contract

This is the part that matters, because a broken credential provider can make a machine unsignable.

- **No ticket → zero credentials.** `GetCredentialCount` returns 0 and sets no auto-logon, so at
  every ordinary sign-in the provider is invisible and LogonUI behaves exactly as if it were not
  installed. This is the default path; the ticket path is the exception.
- **We never implement `ICredentialProviderFilter`.** The stock password tile is never hidden,
  never disabled, and never replaced as the default. There is always a normal way in.
- **`SetUsageScenario` returns `E_NOTIMPL`** for anything but `CPUS_LOGON` and
  `CPUS_UNLOCK_WORKSTATION`, so we stay out of CredUI and password changes entirely.
- **The ticket is one-shot.** The registry value is deleted on read, whether or not it parsed, so a
  malformed or expired ticket cannot be retried at every sign-in.
- **The ticket expires** (default 120 s) and is DPAPI machine-scope encrypted under a key readable
  only by SYSTEM and Administrators.
- Failure of any step degrades to *nothing happens*, never to *cannot sign in*.

`Unregister-Provider.ps1` removes all of it and is safe to run at any time.

## Files

| | |
|---|---|
| `SwiffCP.h` | Ticket layout and the shared contract |
| `Ticket.cpp` | DPAPI read, expiry check, one-shot delete |
| `Credential.cpp` | The tile; packs `KERB_INTERACTIVE_UNLOCK_LOGON` for LSA |
| `Provider.cpp` | `ICredentialProvider`, class factory, DLL exports |
| `build.cmd` | x64 build via vswhere + vcvarsall |
| `Register-Provider.ps1` / `Unregister-Provider.ps1` | Install / remove |
| `Write-Ticket.ps1` | Writes the one-shot ticket |

## Build and install

```powershell
.\build.cmd                                     # -> build\SwiffCP.dll
.\Register-Provider.ps1                         # elevated
.\Write-Ticket.ps1 -UserName swiff-x -Password '...'   # elevated
# then disconnect the owner's session to trigger LogonUI
```

## Status

**Built, registered and proven on hardware — 2026-09-30, A6, Windows 11 Pro.**

`Prove-CredProvider.ps1` ran the whole path end to end:

| Step | Result |
|---|---|
| DLL loads in LogonUI, invisible without a ticket | PASS (Win+L showed the normal screen) |
| Provider logs the renter in with no interaction | PASS - session 2, Active, ~3 s after disconnect |
| Renter lands on the physical console (real GPU + DWM) | PASS - renter session 2 = console session 2 |
| Owner gets the console back | PASS - automatic, via a SYSTEM `tscon` |
| Account, profile, ticket, tasks, share all cleared | PASS - `C:\Users` back to `Public, tomsc` |

The one non-pass was the in-session screenshot: the capture harness (first-run C++/C# compile plus
Explorer startup) ran past its 60 s window. Not a provider issue - the renter session is on the
console, and GPU-on-console capture at 49 fps native is already proven in
[`../isolation-proof`](../isolation-proof/README.md) (`Prove-SwitchDesktop.ps1`).

**This is the path.** One click disconnects the owner; the provider auto-submits a one-shot ticket;
the renter gets a real console session with the real GPU; one `tscon` hands it back. No reboot, no
RDP, no account picker - which is exactly what the product needs.

## First-logon setup, and the account model

Testing surfaced one thing the proof's throwaway-per-session account hid: **a brand-new Windows
account runs the first-logon setup** ("finishing setup", choose-privacy pages, the "Hi" animation)
on its first sign-in, and someone has to click through it. On a rental machine, nobody can.

Two changes fix it, and together they also simplify the lifecycle in
[`../../docs/system-design/host.md`](../../docs/system-design/host.md) (currently "create at start,
wipe at end"):

**1. Suppress the setup - `Set-OobeSuppression.ps1`.** Machine policies plus Default-User-hive seeds:

| Setting | Kills |
|---|---|
| `OOBE\DisablePrivacyExperience = 1` | the choose-privacy-settings pages (the main offender) |
| `Winlogon\EnableFirstLogonAnimation = 0` | the "Hi, we're setting things up" animation |
| `CloudContent\DisableWindowsConsumerFeatures = 1` | promo/suggested-app installs |
| Default hive `ScoobeSystemSettingEnabled = 0` | the "let's finish setting up your device" nag |

**2. One persistent account, not one per session.**

| | |
|---|---|
| `Provision-RenterAccount.ps1` | creates `swiff-renter` once, applies suppression, stores its password DPAPI-machine-scope in HKLM for the service to write tickets |
| `Reset-RenterProfile.ps1 -Snapshot` | after the account's one clean first logon, captures the pristine profile as a baseline |
| `Reset-RenterProfile.ps1` | between renters, `robocopy /MIR` restores the baseline over the live profile - a clean slate, but the account and its `ntuser.dat` survive, so **no first-logon ever again** |

The account is created and goes through first logon exactly once, ever. Every subsequent renter
reuses it with a reset profile, so there is nothing to click and no per-session profile-creation
delay. Save-data continuity (host.md requirement 8) also gets easier: saves are restored into the
reset profile rather than a fresh one each time.

**Proven on hardware - 2026-09-30.** `Prove-PersistentRenter.ps1` ran both phases:

| | First logon (happens once, ever) | Every reused login |
|---|---|---|
| Privacy / "finish setup" pages | none (suppressed) | none |
| "Getting everything ready" animation | brief, one time | **none** |
| Reaches the desktop unattended | yes (`explorer` starts on its own) | yes |
| First-run processes still up | only `FirstLogonAnim`, momentarily | **none** |
| Real console session + GPU | yes | yes |

The reuse run restored the profile from the baseline (`robocopy` backup mode, volatile caches
skipped), logged the renter straight onto the console as session 4, and reached the desktop with
nothing on screen but the desktop. That is the target experience: one click, no reboot, no account
picker, no setup.

Snapshot note: a live profile always has a few locked cache files, so `robocopy` returns code 8 -
harmless. The reset skips the volatile cache/temp trees and treats "`ntuser.dat` restored" as the
success test rather than a spotless mirror.

### Still to build
- A **session-start splash** - a borderless top-most "Preparing isolated gaming environment..."
  window shown until the stream connects, to cover the brief logon spinner with our own branding.
  (The OS "getting everything ready" text is not officially customisable, and no longer appears on
  reused logins anyway - so we cover the gap rather than rewrite Windows.)
- Authenticode signing of the DLL.
- The SYSTEM service that writes the ticket, disconnects the owner, and restores the console.

### The classifier note

Every elevated step here (build, register, run) was blocked by Claude Code's safety classifier and
had to be run by the owner via the `!` prefix. That is correct behaviour - installing into the
Windows auth stack is high-risk - but worth knowing for anyone reproducing this.

Not done yet, and needed before this is more than a prototype:
- Authenticode signing. Unsigned, it still loads, but it is exactly the shape antivirus flags — and
  `host.md` already requires a signed installer.
- The SYSTEM service that writes the ticket and disconnects the owner. Currently manual scripts.
- Restoring the owner: `tscon <owner> /dest:console` once the renter session ends.
- A recovery path documented for the owner if LogonUI ever misbehaves (Safe Mode, second admin).
