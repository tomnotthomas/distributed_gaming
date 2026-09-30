# Prove-CredProvider.ps1 - the whole point of the credential provider, end to end.
#
#   1. create a throwaway standard account
#   2. write a one-shot logon ticket for it
#   3. disconnect the owner's console session   -> LogonUI appears
#   4. our provider sees the ticket and auto-submits it
#   5. the throwaway account lands a real session ON THE CONSOLE (real GPU + DWM)
#   6. capture from inside it to prove the GPU is real
#   7. give the owner the console back, delete the account
#
# No RDP, no loopback, no reboot. That is the advantage over the tscon path, which Windows blocks.
#
# The owner's screen goes dark and comes back on the renter session, then back to the owner. A
# SYSTEM watchdog reconnects the owner even if this script dies. Must run elevated, and the
# provider must already be registered (Register-Provider.ps1).

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-cp-proof',
  [int]$TicketSeconds = 120,
  [int]$LogonTimeout = 45,
  [int]$CaptureMs = 4000,
  [int]$WatchdogSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$iso   = Join-Path (Split-Path $root -Parent) 'isolation-proof'
$outDir = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-cp-proof'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$progressFile = Join-Path $outDir 'cp-progress.txt'
Set-Content -Path $progressFile -Value "started $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function Progress { param([string]$m) try { Add-Content $progressFile ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Note { param([string]$m) Write-Host "     $m"; Progress $m }

$steps = New-Object System.Collections.Generic.List[object]
function Step { param([string]$Claim, [bool]$Pass, [string]$Detail)
  $steps.Add([pscustomobject]@{ claim = $Claim; pass = $Pass; detail = $Detail })
  $l = "[{0}] {1} - {2}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Claim, $Detail
  Write-Host $l; Progress $l }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

# Provider must be registered, or this proves nothing.
$cpKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{7A1F3C92-5D48-4B6E-A3C1-2F9E8D0B4A76}'
if (-not (Test-Path $cpKey)) { throw 'Provider not registered - run Register-Provider.ps1 first.' }
if (-not (Test-Path 'HKLM:\SOFTWARE\Swiff\Logon')) { throw 'Ticket key missing - re-run Register-Provider.ps1.' }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition (Get-Content (Join-Path $iso 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$sys = Join-Path $env:WINDIR 'System32'
$ownerSession = [int](Get-Process -Id $PID).SessionId
$taskWatch = 'swiff-cp-restore-owner'
$taskTscon = 'swiff-cp-tscon'
$taskCap   = 'swiff-cp-capture'
$sid = $null
$renterSession = $null
$startupCmd = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\swiff-cp-capture.cmd'

function Invoke-Schtasks { param([string[]]$A)
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & schtasks @A 2>&1 | Out-String; return @{ ok = ($LASTEXITCODE -eq 0); out = $o.Trim() } }
  catch { return @{ ok = $false; out = $_.Exception.Message } }
  finally { $ErrorActionPreference = $old } }

function Invoke-AsSystem { param([string]$Task, [string]$Cmd)
  $st = (Get-Date).AddMinutes(30).ToString('HH:mm')
  Invoke-Schtasks @('/create','/tn',$Task,'/ru','SYSTEM','/rl','HIGHEST','/sc','once','/st',$st,'/tr',$Cmd,'/f') | Out-Null
  Invoke-Schtasks @('/run','/tn',$Task) | Out-Null }

# Register a one-time SYSTEM task at a full DateTime (date preserved across midnight) and report
# success, for the delayed watchdog we must have in place before disconnecting the owner.
function Register-WatchdogAt {
  param([string]$Name, [string]$Exe, [string]$Argument, [datetime]$At)
  try {
    $act = New-ScheduledTaskAction -Execute $Exe -Argument $Argument
    $trg = New-ScheduledTaskTrigger -Once -At $At
    $pr  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $Name -Action $act -Trigger $trg -Principal $pr -Force -ErrorAction Stop | Out-Null
    return $true
  } catch { Note "watchdog registration error: $($_.Exception.Message)"; return $false }
}

# Inline DPAPI ticket write, matching struct SwiffTicket exactly.
function Write-Ticket { param([string]$User, [string]$Pw, [int]$Secs)
  $MAX_USER = 64; $MAX_PW = 256; $SIZE = 4 + 8 + ($MAX_USER*2) + ($MAX_PW*2)
  $buf = New-Object byte[] $SIZE
  $ms = New-Object IO.MemoryStream(,$buf); $bw = New-Object IO.BinaryWriter($ms,[Text.Encoding]::Unicode)
  $bw.Write([uint32]1)
  $bw.Write([int64]((Get-Date).ToUniversalTime().AddSeconds($Secs).ToFileTimeUtc()))
  function WF { param($W,$S,$C) $b=[Text.Encoding]::Unicode.GetBytes($S); $W.Write($b); $W.Write((New-Object byte[] (($C*2)-$b.Length))) }
  WF $bw $User $MAX_USER; WF $bw $Pw $MAX_PW; $bw.Flush()
  $enc = [Security.Cryptography.ProtectedData]::Protect($buf,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  [Array]::Clear($buf,0,$buf.Length); $bw.Dispose(); $ms.Dispose()
  Set-ItemProperty 'HKLM:\SOFTWARE\Swiff\Logon' -Name 'Ticket' -Value $enc -Type Binary
  return $enc.Length }

try {
  # ---------------------------------------------------------------- account
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $u = New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
        -FullName 'Swiff cred-provider proof' -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value
  Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue
  $inAdmins = (Get-LocalGroupMember Administrators | ForEach-Object { $_.SID.Value }) -contains $sid
  Step 'throwaway account created, not an administrator' (-not $inAdmins) "SID $sid"

  # ---------------------------------------------------------------- capture payload for the renter
  New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
  Copy-Item (Join-Path $iso 'Win32Iso.cs') $shareDir -Force
  Copy-Item (Join-Path $iso 'Dda.cs') $shareDir -Force
  Copy-Item (Join-Path $iso 'Capture-InSession.ps1') $shareDir -Force
  & icacls $shareDir /grant "${UserName}:(OI)(CI)F" /T 2>&1 | Out-Null
  $capCmd = Join-Path $shareDir 'capture.cmd'
  Set-Content -Path $capCmd -Encoding ASCII -Value @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$shareDir\Capture-InSession.ps1" -ShareDir "$shareDir" -CaptureMs $CaptureMs -ExpectUser "$UserName" -OwnerProfile "$env:USERPROFILE" > "$shareDir\capture.log" 2>&1
"@
  Copy-Item $capCmd $startupCmd -Force   # runs when the renter's session starts
  Note 'capture payload staged (Startup folder, guarded to the proof account)'

  # ---------------------------------------------------------------- watchdog + before-state
  # The watchdog is the only automatic recovery if this script dies while the owner is disconnected;
  # require it before we go any further.
  $wdOk = Register-WatchdogAt $taskWatch "$sys\tscon.exe" "$ownerSession /dest:console" ((Get-Date).AddSeconds($WatchdogSeconds))
  Step 'watchdog registered before disconnecting the owner' $wdOk "reconnect owner to console in ~$WatchdogSeconds s"
  if (-not $wdOk) { throw 'watchdog registration failed - not disconnecting the owner without a recovery path' }

  $before = [Iso]::Sessions() | Where-Object { $_.User -eq $UserName }
  Step 'no renter session before we start' (@($before).Count -eq 0) "owner is session $ownerSession on the console"

  # ---------------------------------------------------------------- ticket + disconnect
  $len = Write-Ticket $UserName $plain $TicketSeconds
  Note "ticket written ($len bytes, valid ${TicketSeconds}s)"

  Progress 'PHASE: disconnecting owner - LogonUI should auto-submit the ticket'
  $ErrorActionPreference = 'Continue'
  & "$sys\tsdiscon.exe" $ownerSession 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'

  # ---------------------------------------------------------------- did the provider log us in?
  $deadline = (Get-Date).AddSeconds($LogonTimeout)
  while ((Get-Date) -lt $deadline) {
    $s = @([Iso]::Sessions() | Where-Object { $_.User -eq $UserName -and $_.State -in @('Active','Connected') })
    if ($s.Count -gt 0) { $renterSession = $s[0]; break }
    Start-Sleep -Milliseconds 700
  }
  Step 'the provider logged the renter in with no interaction' ($null -ne $renterSession) `
    $(if ($renterSession) { "session $($renterSession.Id), state $($renterSession.State)" } else { "no session within ${LogonTimeout}s" })
  if (-not $renterSession) { throw 'provider did not create a session' }

  $consoleId = [int][Iso]::ConsoleSessionId()
  Step 'the renter session is on the physical console (real GPU + DWM)' ([int]$renterSession.Id -eq $consoleId) `
    "renter session $($renterSession.Id), console session $consoleId"

  # ---------------------------------------------------------------- capture from inside it
  Progress 'PHASE: waiting for in-session capture'
  $evidence = Join-Path $shareDir 'session-evidence.json'
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $evidence)) { Start-Sleep -Milliseconds 700 }
  if (Test-Path $evidence) {
    $ev = Get-Content $evidence -Raw | ConvertFrom-Json
    Copy-Item $evidence (Join-Path $outDir 'cp-session-evidence.json') -Force
    if (Test-Path (Join-Path $shareDir 'session-dda.png')) { Copy-Item (Join-Path $shareDir 'session-dda.png') (Join-Path $outDir 'cp-session-dda.png') -Force }
    Note "in-session: user=$($ev.user) console=$($ev.isConsole) dwm=$($ev.dwmInThisSession) adapter='$($ev.ddaAdapter)' frames=$($ev.ddaFrames) fps=$($ev.ddaFps)"
    Step 'renter session has its own DWM' ([bool]$ev.dwmInThisSession) "dwm.exe: $($ev.dwmPids)"
    Step 'renter session sees the real GPU' ($ev.ddaAdapter -notmatch 'Remote|Basic|Software|WARP' -and $ev.ddaAdapter -ne '') "adapter: '$($ev.ddaAdapter)'"
    Step 'GPU capture works in the renter session' (([int]$ev.ddaFrames -gt 0) -and [bool]$ev.ddaPngWritten) "frames=$($ev.ddaFrames) fps=$($ev.ddaFps) colours=$($ev.ddaColors)"
  } else {
    Step 'in-session capture produced evidence' $false 'no session-evidence.json'
  }
}
catch { Write-Host "ERROR: $($_.Exception.Message)"; Progress "ERROR: $($_.Exception.Message)"; Step 'run completed without error' $false $_.Exception.Message }
finally {
  $ErrorActionPreference = 'Continue'
  Progress 'PHASE: teardown'
  function Safely { param([string]$W,[scriptblock]$D) try { & $D } catch { Note "$W failed: $($_.Exception.Message)" } }

  # Ticket first - never leave a live ticket behind.
  Safely 'clear ticket' { Remove-ItemProperty 'HKLM:\SOFTWARE\Swiff\Logon' -Name 'Ticket' -ErrorAction SilentlyContinue }

  # Owner back on the console.
  Safely 'reconnect owner' { Invoke-AsSystem $taskTscon "$sys\tscon.exe $ownerSession /dest:console" }
  Start-Sleep -Seconds 3
  $consoleNow = -1; Safely 'read console' { $script:consoleNow = [int][Iso]::ConsoleSessionId() }
  Step 'the owner has the console back' ($consoleNow -eq $ownerSession) "console session = $consoleNow (owner $ownerSession)"

  # Renter session + account.
  if ($renterSession) { Safely 'logoff renter' { & "$sys\logoff.exe" $renterSession.Id 2>&1 | Out-Null } }
  Safely 'kill renter procs' { Get-CimInstance Win32_Process | ForEach-Object {
      $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      if ($o -and $o.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } }

  # Keep the watchdog if the owner is NOT confirmed back on the console - it is the remaining
  # recovery path. Delete it only once restoration is verified.
  foreach ($t in @($taskTscon,$taskCap)) { Invoke-Schtasks @('/delete','/tn',$t,'/f') | Out-Null }
  if ($consoleNow -eq $ownerSession) {
    Invoke-Schtasks @('/delete','/tn',$taskWatch,'/f') | Out-Null
  } else {
    Note "owner not confirmed on console - LEAVING watchdog '$taskWatch' armed; recovery pending"
  }
  Safely 'remove startup item' { Remove-Item $startupCmd -Force -ErrorAction SilentlyContinue }

  if ($sid) { for ($i=1;$i -le 8;$i++) { $p=$null; Safely 'query profile' { $script:p = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } }
      if (-not $p) { break }; try { Remove-CimInstance -InputObject $p -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 } } }
  Safely 'remove user' { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue }
  Safely 'remove share' { Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue }

  $userGone = $null -eq (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
  $left = @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$UserName*" })
  $ticketGone = $null -eq (Get-ItemProperty 'HKLM:\SOFTWARE\Swiff\Logon' -Name 'Ticket' -ErrorAction SilentlyContinue)
  Step 'account, profile and ticket all cleared' ($userGone -and $left.Count -eq 0 -and $ticketGone) `
    "user gone: $userGone; leftovers: $(if ($left.Count) { ($left|ForEach-Object Name) -join ',' } else { 'none' }); ticket cleared: $ticketGone"

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
  Write-Host ("ALL PASSED: {0}" -f (@($steps | Where-Object { -not $_.pass }).Count -eq 0))
}
