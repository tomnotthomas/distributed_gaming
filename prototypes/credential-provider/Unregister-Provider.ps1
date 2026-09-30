# Removes every trace of the credential provider. Must run elevated.
# Safe to run at any time, including when nothing is registered.

$ErrorActionPreference = 'Continue'

$CLSID = '{7A1F3C92-5D48-4B6E-A3C1-2F9E8D0B4A76}'
$InstallPath = "$env:WINDIR\System32\SwiffCP.dll"

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$CLSID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKLM:\SOFTWARE\Classes\CLSID\$CLSID" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKLM:\SOFTWARE\Swiff' -Recurse -Force -ErrorAction SilentlyContinue

# LogonUI may still hold the DLL; if so, schedule it for deletion on the next boot.
if (Test-Path $InstallPath) {
  try { Remove-Item $InstallPath -Force -ErrorAction Stop; Write-Host "deleted $InstallPath" }
  catch { Write-Host "DLL in use; it will be removed on reboot: $InstallPath" }
}

Write-Host "`n--- state ---"
Write-Host "provider key : $(Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\$CLSID")"
Write-Host "CLSID key    : $(Test-Path "HKLM:\SOFTWARE\Classes\CLSID\$CLSID")"
Write-Host "ticket key   : $(Test-Path 'HKLM:\SOFTWARE\Swiff')"
Write-Host "dll present  : $(Test-Path $InstallPath)"
