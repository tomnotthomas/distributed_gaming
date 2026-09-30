# Registers SwiffCP.dll as a credential provider. Must run elevated.
#
# Registration alone changes nothing visible: with no ticket present the provider reports zero
# credentials, so the sign-in screen looks and behaves exactly as before. We never register an
# ICredentialProviderFilter, so the stock password tile is never hidden or disabled.
#
# Undo with Unregister-Provider.ps1.

[CmdletBinding()]
param(
  [string]$Dll = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'build\SwiffCP.dll'),
  [string]$InstallPath = "$env:WINDIR\System32\SwiffCP.dll"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$CLSID = '{7A1F3C92-5D48-4B6E-A3C1-2F9E8D0B4A76}'
$NAME  = 'Swiff Credential Provider'

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }
if (-not (Test-Path $Dll)) { throw "DLL not found: $Dll  (run build.cmd first)" }

# Sanity-check the binary before letting LogonUI anywhere near it.
$bytes = [IO.File]::ReadAllBytes($Dll)
if ($bytes.Length -lt 1024 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw 'Not a valid PE image.' }

Copy-Item $Dll $InstallPath -Force
Write-Host "installed -> $InstallPath"

# COM server registration
$clsidKey = "HKLM:\SOFTWARE\Classes\CLSID\$CLSID"
New-Item -Path $clsidKey -Force | Out-Null
Set-ItemProperty -Path $clsidKey -Name '(default)' -Value $NAME
New-Item -Path "$clsidKey\InprocServer32" -Force | Out-Null
Set-ItemProperty -Path "$clsidKey\InprocServer32" -Name '(default)' -Value $InstallPath
Set-ItemProperty -Path "$clsidKey\InprocServer32" -Name 'ThreadingModel' -Value 'Apartment'
Write-Host "registered COM server $CLSID"

# Credential provider registration
$cpKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$CLSID"
New-Item -Path $cpKey -Force | Out-Null
Set-ItemProperty -Path $cpKey -Name '(default)' -Value $NAME
Write-Host "registered credential provider"

# The ticket key, locked to SYSTEM and Administrators only. LogonUI runs as SYSTEM and reads it.
# Set only the DACL (protected) - setting the key owner needs a privilege we would rather not rely
# on, and the DACL is what enforces the lock-down.
$ticketKey = 'HKLM:\SOFTWARE\Swiff\Logon'
New-Item -Path $ticketKey -Force | Out-Null
$acl = New-Object System.Security.AccessControl.RegistrySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($who in 'SYSTEM', 'Administrators') {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
    $who, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $ticketKey -AclObject $acl
Write-Host "ticket key $ticketKey created (SYSTEM + Administrators only)"

Write-Host "`nRegistered. With no ticket written, the sign-in screen is unchanged."
Write-Host "Undo: .\Unregister-Provider.ps1"
