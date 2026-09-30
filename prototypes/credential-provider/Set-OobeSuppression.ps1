# Set-OobeSuppression.ps1 - stop Windows showing first-logon setup pages to the renter.
#
# A brand-new account's first sign-in runs the "finishing setup / choose privacy settings" pages
# and the "Hi, we're setting things up" animation. On a rental machine there is nobody to click
# through them. This applies the machine-wide policies that suppress them, and seeds the Default
# User hive so any new profile inherits the quiet settings too.
#
# Idempotent. Undo with -Revert. Must run elevated.

[CmdletBinding()]
param([switch]$Revert)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

# name -> @{ Path; Name; Value; Type }. Value is what we set; on -Revert we delete the value.
$machine = @(
  @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE';         Name = 'DisablePrivacyExperience';       Value = 1; Type = 'DWord' }
  @{ Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Winlogon'; Name = 'EnableFirstLogonAnimation';    Value = 0; Type = 'DWord' }
  @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'; Name = 'DisableWindowsConsumerFeatures'; Value = 1; Type = 'DWord' }
  @{ Path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'; Name = 'DisableConsumerAccountStateContent'; Value = 1; Type = 'DWord' }
)

# Applied inside the Default User hive, so every newly created profile inherits them.
$defaultHive = @(
  @{ SubKey = 'Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement'; Name = 'ScoobeSystemSettingEnabled'; Value = 0 }  # "let's finish setting up"
  @{ SubKey = 'Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'; Name = 'SilentInstalledAppsEnabled'; Value = 0 }  # auto-installed promo apps
  @{ SubKey = 'Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'; Name = 'SubscribedContent-338388Enabled'; Value = 0 }  # suggestions
  @{ SubKey = 'Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'; Name = 'SubscribedContent-310093Enabled'; Value = 0 }
)

function Apply-Machine {
  foreach ($e in $machine) {
    if ($Revert) {
      if (Test-Path $e.Path) { Remove-ItemProperty -Path $e.Path -Name $e.Name -ErrorAction SilentlyContinue }
      Write-Host "  removed $($e.Name)"
    } else {
      New-Item -Path $e.Path -Force | Out-Null
      Set-ItemProperty -Path $e.Path -Name $e.Name -Value $e.Value -Type $e.Type
      Write-Host "  set $($e.Name) = $($e.Value)"
    }
  }
}

function Apply-DefaultHive {
  $hive = 'C:\Users\Default\NTUSER.DAT'
  if (-not (Test-Path $hive)) { Write-Host '  (no Default\NTUSER.DAT - skipping)'; return }
  $mount = 'HKLM\SwiffDefault'
  & reg load $mount $hive 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host '  (could not load Default hive - it may be in use)'; return }
  try {
    foreach ($e in $defaultHive) {
      $full = "Registry::$mount\$($e.SubKey)"
      if ($Revert) {
        if (Test-Path $full) { Remove-ItemProperty -Path $full -Name $e.Name -ErrorAction SilentlyContinue }
      } else {
        New-Item -Path $full -Force | Out-Null
        Set-ItemProperty -Path $full -Name $e.Name -Value $e.Value -Type DWord
      }
    }
    Write-Host "  default-user hive $(if ($Revert) { 'reverted' } else { 'seeded' })"
  } finally {
    [gc]::Collect()   # release the handles reg needs to unload cleanly
    Start-Sleep -Milliseconds 500
    & reg unload $mount 2>&1 | Out-Null
  }
}

Write-Host "$(if ($Revert) { 'Reverting' } else { 'Applying' }) OOBE suppression..."
Apply-Machine
Apply-DefaultHive
Write-Host "done. (existing profiles are unaffected; this governs the first logon of new ones)"
