# Prove-PersistentRenter.ps1 - the persistent-account + OOBE-suppression flow, end to end.
#
# Run it TWICE:
#   run 1  provisions swiff-renter (once), first logon happens with suppression in force, and if the
#          renter reaches the desktop cleanly it snapshots that profile as the baseline.
#   run 2+ restores the baseline over the profile, logs the renter in again, and confirms the reused
#          login reaches the desktop with nothing to click.
#
# "Reached the desktop cleanly" is measured, not eyeballed: explorer.exe appearing on its own in the
# renter session means no blocking first-run page. Any OOBE/first-run process still up is reported.
#
# Leaves swiff-renter and its baseline in place (the deliverable). Unregisters the provider at the
# end, matching the machine's current clean state. -RemoveAll tears everything down. Must run
# elevated, from this folder.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-renter',
  [int]$LogonTimeout = 60,
  [int]$DesktopTimeout = 45,
  [int]$ObserveSeconds = 12,
  [int]$WatchdogSeconds = 160,
  [switch]$RemoveAll
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$iso   = Join-Path (Split-Path $root -Parent) 'isolation-proof'
$outDir = Join-Path $root 'out'
$baseline = 'C:\ProgramData\Swiff\renter-baseline'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$progress = Join-Path $outDir 'persistent-progress.txt'
Set-Content -Path $progress -Value "started $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function Progress { param([string]$m) try { Add-Content $progress ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Note { param([string]$m) Write-Host "     $m"; Progress $m }
$steps = New-Object System.Collections.Generic.List[object]
function Step { param([string]$C, [bool]$P, [string]$D)
  $steps.Add([pscustomobject]@{ claim = $C; pass = $P; detail = $D })
  $l = "[{0}] {1} - {2}" -f $(if ($P) { 'PASS' } else { 'FAIL' }), $C, $D; Write-Host $l; Progress $l }

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition (Get-Content (Join-Path $iso 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$sys = Join-Path $env:WINDIR 'System32'
$ownerSession = [int](Get-Process -Id $PID).SessionId
$taskWatch = 'swiff-pr-watch'; $taskTscon = 'swiff-pr-tscon'
# NB: do NOT name this 'Schtasks' - a function whose name matches the command it calls shadows it,
# and '& schtasks' then recurses into the function (call-depth overflow).
function Invoke-Sch { param([string[]]$A) $o=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try { $x = & schtasks.exe @A 2>&1 | Out-String; @{ ok=($LASTEXITCODE -eq 0); out=$x.Trim() } } finally { $ErrorActionPreference=$o } }
function AsSystem { param([string]$T,[string]$C) $st=(Get-Date).AddMinutes(30).ToString('HH:mm')
  Invoke-Sch @('/create','/tn',$T,'/ru','SYSTEM','/rl','HIGHEST','/sc','once','/st',$st,'/tr',$C,'/f') | Out-Null
  Invoke-Sch @('/run','/tn',$T) | Out-Null }

# ---------------------------------------------------------------- RemoveAll
if ($RemoveAll) {
  Write-Host 'removing persistent renter, baseline, stored password, and provider registration'
  & (Join-Path $root 'Unregister-Provider.ps1')
  $u = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  if ($u) {
    $sid = $u.SID.Value
    Get-CimInstance Win32_Process | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      if ($o -and $o.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
    $p = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
    if ($p) { try { Remove-CimInstance -InputObject $p -ErrorAction Stop } catch {} }
    Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  }
  Remove-Item -Recurse -Force $baseline -ErrorAction SilentlyContinue
  Remove-Item -Path 'HKLM:\SOFTWARE\Swiff' -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "removed. account present: $([bool](Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue))"
  return
}

$renterSession = $null
$doSnapshot = $false

try {
  # ---------------------------------------------------------------- ensure everything is in place
  & (Join-Path $root 'Provision-RenterAccount.ps1') -UserName $UserName | Out-Null   # idempotent
  & (Join-Path $root 'Register-Provider.ps1') | Out-Null                             # idempotent

  $sid = (Get-LocalUser -Name $UserName).SID.Value
  $profileExists = [bool](Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid })
  $baselineExists = Test-Path (Join-Path $baseline 'NTUSER.DAT')

  $mode = if (-not $profileExists) { 'firstlogon' } elseif ($baselineExists) { 'reuse' } else { 'firstlogon-again' }
  Note "mode = $mode (profile exists: $profileExists, baseline: $baselineExists)"

  if ($mode -eq 'reuse') {
    & (Join-Path $root 'Reset-RenterProfile.ps1') -UserName $UserName | Out-Null
    Note 'profile reset to clean baseline'
  }

  # ---------------------------------------------------------------- read the stored password
  $pwEnc = (Get-ItemProperty 'HKLM:\SOFTWARE\Swiff\Renter' -Name 'Pw').Pw
  $plain = [Text.Encoding]::Unicode.GetString(
             [Security.Cryptography.ProtectedData]::Unprotect($pwEnc, $null,
               [Security.Cryptography.DataProtectionScope]::LocalMachine))

  # ---------------------------------------------------------------- ticket
  $MAX_USER=64; $MAX_PW=256; $SIZE=4+8+($MAX_USER*2)+($MAX_PW*2)
  $buf = New-Object byte[] $SIZE; $ms = New-Object IO.MemoryStream(,$buf)
  $bw = New-Object IO.BinaryWriter($ms,[Text.Encoding]::Unicode)
  $bw.Write([uint32]1); $bw.Write([int64]((Get-Date).ToUniversalTime().AddSeconds(120).ToFileTimeUtc()))
  function WF { param($W,$S,$C) $b=[Text.Encoding]::Unicode.GetBytes($S); $W.Write($b); $W.Write((New-Object byte[] (($C*2)-$b.Length))) }
  WF $bw $UserName $MAX_USER; WF $bw $plain $MAX_PW; $bw.Flush()
  $enc = [Security.Cryptography.ProtectedData]::Protect($buf,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  [Array]::Clear($buf,0,$buf.Length); $plain=$null
  Set-ItemProperty 'HKLM:\SOFTWARE\Swiff\Logon' -Name 'Ticket' -Value $enc -Type Binary
  Note "ticket written for $UserName"

  # ---------------------------------------------------------------- watchdog + disconnect
  Invoke-Sch @('/create','/tn',$taskWatch,'/ru','SYSTEM','/rl','HIGHEST','/sc','once',
             '/st',(Get-Date).AddSeconds($WatchdogSeconds).ToString('HH:mm'),
             '/tr',"$sys\tscon.exe $ownerSession /dest:console",'/f') | Out-Null

  Progress 'PHASE: disconnecting owner'
  $ErrorActionPreference='Continue'; & "$sys\tsdiscon.exe" $ownerSession 2>&1 | Out-Null; $ErrorActionPreference='Stop'

  $deadline = (Get-Date).AddSeconds($LogonTimeout)
  while ((Get-Date) -lt $deadline) {
    $s = @([Iso]::Sessions() | Where-Object { $_.User -eq $UserName -and $_.State -in @('Active','Connected') })
    if ($s.Count -gt 0) { $renterSession = $s[0]; break }
    Start-Sleep -Milliseconds 700
  }
  Step 'provider logged the renter in' ($null -ne $renterSession) $(if ($renterSession) { "session $($renterSession.Id)" } else { 'no session' })
  if (-not $renterSession) { throw 'no renter session' }
  $rsid = [int]$renterSession.Id

  # ---------------------------------------------------------------- the actual question: clean desktop?
  Progress 'PHASE: waiting for explorer in the renter session'
  $reached = $false
  $deadline = (Get-Date).AddSeconds($DesktopTimeout)
  while ((Get-Date) -lt $deadline) {
    $exp = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $rsid })
    if ($exp.Count -gt 0) { $reached = $true; break }
    Start-Sleep -Milliseconds 700
  }
  # Any first-run / OOBE process still up in the renter session is the smoking gun if it did NOT.
  $oobeNames = 'msoobe|CloudExperienceHost|WWAHost|FirstLogonAnim|UserOOBEBroker|SystemSettings|Windows.UI.Immersive'
  $oobe = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $rsid -and $_.ProcessName -match $oobeNames } | ForEach-Object ProcessName | Sort-Object -Unique)
  Step 'renter reached the desktop with nothing to click' $reached `
    "explorer in session ${rsid}: $reached; first-run processes present: $(if ($oobe.Count) { $oobe -join ',' } else { 'none' })"

  Note "observing $ObserveSeconds s - look at the screen now"
  Start-Sleep -Seconds $ObserveSeconds

  if ($mode -ne 'reuse' -and $reached) { $doSnapshot = $true }
}
catch { Write-Host "ERROR: $($_.Exception.Message)"; Progress "ERROR: $($_.Exception.Message)"; Step 'run completed without error' $false $_.Exception.Message }
finally {
  $ErrorActionPreference='Continue'
  Progress 'PHASE: teardown'
  function Safely { param([string]$W,[scriptblock]$D) try { & $D } catch { Note "$W failed: $($_.Exception.Message)" } }

  Safely 'clear ticket' { Remove-ItemProperty 'HKLM:\SOFTWARE\Swiff\Logon' -Name 'Ticket' -ErrorAction SilentlyContinue }
  if ($renterSession) { Safely 'logoff renter' { & "$sys\logoff.exe" $renterSession.Id 2>&1 | Out-Null } }
  Safely 'reconnect owner' { AsSystem $taskTscon "$sys\tscon.exe $ownerSession /dest:console" }
  Start-Sleep -Seconds 3
  $consoleNow = -1; Safely 'read console' { $script:consoleNow = [int][Iso]::ConsoleSessionId() }
  Step 'owner has the console back' ($consoleNow -eq $ownerSession) "console = $consoleNow (owner $ownerSession)"

  # Snapshot only after the renter is logged off (ntuser.dat unloaded), only on a clean first logon.
  if ($doSnapshot) {
    Start-Sleep -Seconds 2
    Safely 'snapshot baseline' { & (Join-Path $root 'Reset-RenterProfile.ps1') -UserName $UserName -Snapshot | Out-Null; Note 'baseline captured' }
  }

  foreach ($t in @($taskWatch,$taskTscon)) { Invoke-Sch @('/delete','/tn',$t,'/f') | Out-Null }
  # Leave the account + baseline (the deliverable); restore the provider to unregistered.
  Safely 'unregister provider' { & (Join-Path $root 'Unregister-Provider.ps1') | Out-Null }

  $baseNow = Test-Path (Join-Path $baseline 'NTUSER.DAT')
  Note "account swiff-renter present: $([bool](Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)); baseline present: $baseNow"

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
}
