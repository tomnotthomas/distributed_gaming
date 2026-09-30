# Provision-RenterAccount.ps1 - create the ONE persistent renter account, once.
#
# The proof used a throwaway account created and deleted per session. That is what forced the
# first-logon setup: every session was a brand-new account. Instead, provision a single account
# now, let it go through first logon exactly once (with OOBE already suppressed), and reuse it for
# every renter - resetting its profile between them (Reset-RenterProfile.ps1) rather than deleting
# it. No new account -> no first-logon experience, ever again.
#
# The account password is generated here and stored DPAPI machine-scope in HKLM (SYSTEM+Admins
# only), so the host service can write logon tickets for it without a human knowing it.
#
# Must run elevated.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-renter',
  [switch]$ResetPassword   # rotate the stored password on an already-provisioned account
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

Add-Type -AssemblyName System.Security
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. OOBE suppression first, so it is in force before the account's first logon.
& (Join-Path $root 'Set-OobeSuppression.ps1')

# 2. a strong random password
function New-Password {
  $b = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b) + '!aA9'
}

# Lock a registry key to SYSTEM + Administrators only, via the DACL alone. Setting the key's owner
# needs a privilege that is awkward to get from an ordinary elevated shell; the DACL is all we need,
# so we set only that and mark it protected so inherited Users-read is dropped.
function Lock-KeyToAdmins {
  param([string]$Path)
  $acl = New-Object System.Security.AccessControl.RegistrySecurity
  $acl.SetAccessRuleProtection($true, $false)   # protected, do not inherit parent ACEs
  foreach ($who in 'SYSTEM', 'Administrators') {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
      $who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -Path $Path -AclObject $acl
}

$key = 'HKLM:\SOFTWARE\Swiff\Renter'
$havePw = (Test-Path $key) -and ($null -ne (Get-ItemProperty $key -Name 'Pw' -ErrorAction SilentlyContinue))
$exists = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
$needStore = (-not $exists) -or $ResetPassword -or (-not $havePw)

if (-not $needStore) {
  Write-Host "account '$UserName' already provisioned (SID $($exists.SID.Value)) and password stored. Use -ResetPassword to rotate."
} else {
  $plain = New-Password
  $sec = ConvertTo-SecureString $plain -AsPlainText -Force
  if ($exists) {
    Set-LocalUser -Name $UserName -Password $sec
    Write-Host "set password for existing '$UserName'"
  } else {
    New-LocalUser -Name $UserName -Password $sec -FullName 'Swiff renter' `
      -Description 'Persistent Swiff rental session account' -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue
    Write-Host "created standard account '$UserName'"
  }

  # store the password, DPAPI machine-scope, locked down
  New-Item -Path $key -Force | Out-Null
  Lock-KeyToAdmins -Path $key
  $enc = [Security.Cryptography.ProtectedData]::Protect(
           [Text.Encoding]::Unicode.GetBytes($plain), $null,
           [Security.Cryptography.DataProtectionScope]::LocalMachine)
  Set-ItemProperty -Path $key -Name 'Pw' -Value $enc -Type Binary
  Set-ItemProperty -Path $key -Name 'User' -Value $UserName -Type String
  $plain = $null
  Write-Host "password stored (DPAPI machine scope) at $key"
}

$sid = (Get-LocalUser -Name $UserName).SID.Value
$profileMade = [bool](Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid })

Write-Host ""
Write-Host "account : $UserName  (SID $sid)"
Write-Host "profile : $(if ($profileMade) { 'exists' } else { 'NOT yet created' })"
if (-not $profileMade) {
  Write-Host ""
  Write-Host "NEXT: log this account in once to build its profile (via the credential provider or"
  Write-Host "a normal sign-in). With suppression applied it should reach the desktop with nothing"
  Write-Host "to click. Then run:  .\Reset-RenterProfile.ps1 -Snapshot   to capture the clean baseline."
}
