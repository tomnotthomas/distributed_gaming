# Reset-RenterProfile.ps1 - clean slate for the next renter, WITHOUT deleting the account.
#
# Deleting the account would force first-logon setup all over again. Instead we keep the account
# (and therefore its profile registration and ntuser.dat, so no OOBE) and restore its profile to a
# pristine baseline captured right after provisioning.
#
#   .\Reset-RenterProfile.ps1 -Snapshot   capture the current profile as the baseline (do this once,
#                                         right after the account's first clean logon)
#   .\Reset-RenterProfile.ps1             restore the profile to that baseline (between renters)
#
# The account must be LOGGED OFF for either - a loaded ntuser.dat cannot be overwritten. Must run
# elevated. robocopy does the heavy lifting; /MIR makes the live profile match the baseline exactly.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-renter',
  [switch]$Snapshot,
  [string]$BaselineDir = 'C:\ProgramData\Swiff\renter-baseline'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

$user = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if (-not $user) { throw "account '$UserName' not found - run Provision-RenterAccount.ps1 first." }
$sid = $user.SID.Value

$prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
if (-not $prof) { throw "profile for '$UserName' does not exist yet - log the account in once first." }
$profPath = $prof.LocalPath

# Must not be logged on, or ntuser.dat is locked.
if ($prof.Loaded) {
  Write-Host "profile is loaded - logging the account off first"
  $sess = & "$env:WINDIR\System32\quser.exe" $UserName 2>$null
  Get-CimInstance Win32_Process | ForEach-Object {
    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
    if ($o -and $o.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 3
  $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
  if ($prof.Loaded) { throw "could not unload the profile - is the renter still signed in on the console?" }
}

# These profile folders and files must never be mirrored - they are the profile's identity/state,
# not user content, and clobbering them would defeat the whole point.
$excludeDirs  = @('AppData\Local\Microsoft\Windows\UsrClass.dat*')
$excludeFiles = @('NTUSER.DAT*', 'ntuser.dat*', 'UsrClass.dat*')

# /b = backup mode: uses SeBackup/SeRestore (we are elevated) to read/write files held with sharing
# locks. /XJ skips junctions (AppData reparse points would otherwise loop). We also skip volatile
# cache/temp trees: they are always partly locked, never matter for a clean baseline, and Windows
# recreates them. What must copy is ntuser.dat and the user's real folders - and those do.
$volatile = @(
  'Temp', 'INetCache', 'WebCache', 'IECompatCache', 'IECompatUACache',
  'CacheStorage', 'GPUCache', 'Code Cache', 'Service Worker',
  'ConnectedDevicesPlatform', 'WER', 'Explorer', 'Diagnostics'
)
$common = @('/MIR', '/COPY:DAT', '/b', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NP', '/NJH', '/NJS', '/XD') + $volatile

if ($Snapshot) {
  Write-Host "capturing baseline of $profPath -> $BaselineDir"
  New-Item -ItemType Directory -Force -Path $BaselineDir | Out-Null
  Start-Sleep -Seconds 5   # let the profile service finish writing a just-created profile
  & robocopy $profPath $BaselineDir @common | Out-Null
  $rc = $LASTEXITCODE
  Write-Host "baseline captured (robocopy code $rc)"
} else {
  if (-not (Test-Path $BaselineDir)) { throw "no baseline at $BaselineDir - run with -Snapshot once first." }
  Write-Host "restoring $profPath from baseline (wipes this renter's data)"
  & robocopy $BaselineDir $profPath @common | Out-Null
  $rc = $LASTEXITCODE
  Write-Host "profile reset to baseline (robocopy code $rc)"
}

# Success is measured by outcome, not by a spotless robocopy code: a live profile always has a few
# locked cache files, which show as bit 3 (8) and do not matter. Bit 4 (16) is a real usage/fatal
# error. The baseline must contain a plausible ntuser.dat.
if ($rc -band 16) { throw "robocopy fatal error (code $rc)" }
$hive = Join-Path $BaselineDir 'NTUSER.DAT'
if ($Snapshot -and (-not (Test-Path $hive) -or (Get-Item $hive -Force).Length -lt 100kb)) {
  throw "baseline has no usable NTUSER.DAT - snapshot is not trustworthy (code $rc)"
}
Write-Host "done (robocopy code ${rc}$(if ($rc -band 8) { '; some locked cache files skipped - expected' }))."
