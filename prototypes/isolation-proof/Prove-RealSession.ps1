# Prove-RealSession.ps1 - the "proper login" path.
#
# Prove-SwitchDesktop.ps1 gave the renter a second DESKTOP inside the owner's session. That
# captured fine but had no DWM, a shared clipboard and a shared audio endpoint. This gives the
# renter a real logon SESSION instead, and hands it the physical console so it gets the real GPU:
#
#   1. disconnect the owner's console session       (tsdiscon)
#   2. log the throwaway account in over loopback   (mstsc /v:localhost)
#   3. move that session onto the physical console  (tscon <id> /dest:console, as SYSTEM)
#   4. capture from inside it                       (Capture-InSession.ps1)
#   5. give the console back to the owner           (tscon <owner> /dest:console, as SYSTEM)
#
# The decisive measurement is which GPU the session's DXGI adapter reports. An RDP session sees
# "Microsoft Remote Display Adapter" and is useless for games; after the console handoff it should
# see the real card. Second decisive field: a dwm.exe of its own.
#
# What this changes on the machine, and puts back in the finally block:
#   - fDenyTSConnections 1 -> 0 (RDP service on). The three RDP firewall rules stay DISABLED, and
#     Windows Firewall does not filter loopback, so only 127.0.0.1 can reach it.
#   - TermService start type, if it had to change.
#   - a saved credential for TERMSRV/localhost, two scheduled tasks, one local account.
#
# THE OWNER'S SCREEN LOCKS. Reconnecting a disconnected session shows the lock screen, so the
# owner types their Windows password once at the end. A SYSTEM watchdog task restores the console
# after -WatchdogMinutes even if this script dies outright.
#
# Must run elevated.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-session-proof',
  [int]$CaptureMs = 4000,
  [int]$WatchdogMinutes = 6,
  [int]$LogonTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir   = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-session-proof'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$steps = New-Object System.Collections.Generic.List[object]
function Step {
  param([string]$Claim, [bool]$Pass, [string]$Detail)
  $steps.Add([pscustomobject]@{ claim = $Claim; pass = $Pass; detail = $Detail })
  $line = "[{0}] {1} - {2}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Claim, $Detail
  Write-Host $line
  Progress $line
}
function Note { param([string]$m) Write-Host "     $m"; Progress $m }
function Safely2 { param([scriptblock]$Do) try { & $Do } catch { Note "  (capture failed: $($_.Exception.Message))" } }

# Out-File buffers, so a wedged run shows a log that stops well before where it actually got to.
# This appends and flushes on every call, which is what makes a hang locatable.
$progressFile = Join-Path $outDir 'progress.txt'
Set-Content -Path $progressFile -Value "run started $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function Progress { param([string]$m)
  try { Add-Content -Path $progressFile -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {} }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$sys      = Join-Path $env:WINDIR 'System32'
$tsKey    = 'HKLM:\System\CurrentControlSet\Control\Terminal Server'
$ownerSid = $id.User.Value
$ownerSession = [int](Get-Process -Id $PID).SessionId

# ---------------------------------------------------------------- snapshot for revert
$origDeny      = (Get-ItemProperty $tsKey -Name fDenyTSConnections).fDenyTSConnections
$origStartType = (Get-Service TermService).StartType
Note "owner session $ownerSession; fDenyTSConnections=$origDeny; TermService=$origStartType"

$sid = $null
$rdpEnabled = $false
$authOverrideSet = $false
$origAuthOverride = $null
$tscKey = 'HKCU:\Software\Microsoft\Terminal Server Client'
$taskTscon = 'swiff-proof-tscon'
$taskWatch = 'swiff-proof-restore-owner'
$taskCap   = 'swiff-proof-capture'
$startupCmd = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\swiff-proof-capture.cmd'
$renterSession = $null

# schtasks writes warnings to stderr, and under $ErrorActionPreference='Stop' a native command's
# stderr becomes a TERMINATING error - `2>&1 | Out-Null` does not stop that. Every schtasks call
# therefore runs with the preference dropped locally. This exact trap killed the first run's
# teardown at its first statement.
function Invoke-Schtasks {
  param([string[]]$Args)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & schtasks @Args 2>&1 | Out-String; return @{ ok = ($LASTEXITCODE -eq 0); out = $out.Trim() } }
  catch { return @{ ok = $false; out = $_.Exception.Message } }
  finally { $ErrorActionPreference = $old }
}

function Invoke-AsSystem {
  param([string]$TaskName, [string]$Command)
  # /st must be in the future or schtasks warns; we trigger it with /run anyway.
  $st = (Get-Date).AddMinutes(30).ToString('HH:mm')
  $r = Invoke-Schtasks @('/create', '/tn', $TaskName, '/ru', 'SYSTEM', '/rl', 'HIGHEST',
                         '/sc', 'once', '/st', $st, '/tr', $Command, '/f')
  if (-not $r.ok) { Note "schtasks create $TaskName failed: $($r.out)"; return $false }
  $r = Invoke-Schtasks @('/run', '/tn', $TaskName)
  if (-not $r.ok) { Note "schtasks run $TaskName failed: $($r.out)" }
  return $r.ok
}

# Wait until something is actually listening on 3389. Start-Service returns before the RDP-Tcp
# listener is accepting, and connecting into that gap is why the first run never got a session.
function Wait-RdpListener {
  param([int]$TimeoutSeconds = 40)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $iar = $c.BeginConnect('127.0.0.1', 3389, $null, $null)
      $ok = $iar.AsyncWaitHandle.WaitOne(1000)
      if ($ok -and $c.Connected) { $c.Close(); return $true }
      $c.Close()
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

try {
  # ---------------------------------------------------------------- 1. the throwaway account
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $u = New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
        -FullName 'Swiff real-session proof' -Description 'Temporary; created by Prove-RealSession.ps1' `
        -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value
  Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue
  Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $UserName -ErrorAction SilentlyContinue

  $inAdmins = (Get-LocalGroupMember -Group 'Administrators' | ForEach-Object { $_.SID.Value }) -contains $sid
  Step 'throwaway account created, not an administrator' (-not $inAdmins) "SID $sid, in Remote Desktop Users"

  # ---------------------------------------------------------------- 2. payload + launcher
  New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
  Copy-Item (Join-Path $root 'Win32Iso.cs') $shareDir -Force
  Copy-Item (Join-Path $root 'Dda.cs') $shareDir -Force
  Copy-Item (Join-Path $root 'Capture-InSession.ps1') $shareDir -Force
  $capCmd = Join-Path $shareDir 'capture.cmd'
  Set-Content -Path $capCmd -Encoding ASCII -Value @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$shareDir\Capture-InSession.ps1" -ShareDir "$shareDir" -CaptureMs $CaptureMs -ExpectUser "$UserName" > "$shareDir\capture.log" 2>&1
"@
  # Capture-InSession waits until its session owns the console, so it can start before the handoff.
  $st = (Get-Date).AddMinutes(30).ToString('HH:mm')
  $r = Invoke-Schtasks @('/create', '/tn', $taskCap, '/ru', "$env:COMPUTERNAME\$UserName", '/rp', $plain,
                         '/it', '/sc', 'once', '/st', $st, '/tr', $capCmd, '/f')
  $capTaskOk = $r.ok
  Note "capture task registered: $capTaskOk $(if (-not $r.ok) { $r.out })"
  # Belt and braces: the Startup folder runs it at logon too. Capture-InSession refuses to do
  # anything unless it is running as the proof account, so the owner logging on is harmless.
  Copy-Item $capCmd $startupCmd -Force

  # ---------------------------------------------------------------- 3. watchdog, before anything switches
  # No /sd - schtasks parses the date in the machine's locale format and gets it wrong otherwise.
  # Omitting it means today, which is what we want for a few minutes out.
  $when = (Get-Date).AddMinutes($WatchdogMinutes)
  $r = Invoke-Schtasks @('/create', '/tn', $taskWatch, '/ru', 'SYSTEM', '/rl', 'HIGHEST',
                         '/sc', 'once', '/st', $when.ToString('HH:mm'),
                         '/tr', "$sys\tscon.exe $ownerSession /dest:console", '/f')
  Step 'watchdog armed to restore the owner console' $r.ok "at $($when.ToString('HH:mm')), tscon $ownerSession /dest:console"

  # ---------------------------------------------------------------- 4. RDP on, loopback only
  Set-ItemProperty $tsKey -Name fDenyTSConnections -Value 0
  if ((Get-Service TermService).StartType -eq 'Disabled') { Set-Service TermService -StartupType Manual }
  Start-Service TermService -ErrorAction SilentlyContinue
  $rdpEnabled = $true
  $fw = @(Get-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' })
  Step 'RDP listening, but only reachable over loopback' ($fw.Count -eq 0) `
    "TermService=$((Get-Service TermService).Status); enabled RDP firewall rules: $($fw.Count) (loopback bypasses the firewall)"

  # NOT an .rdp file. Launching one that is unsigned raises "Caution: Unknown remote connection -
  # we could not verify the publisher", a modal dialog that blocks the connection forever. With the
  # owner's console disconnected there is nobody to click it, which is exactly how the first two
  # runs failed. Command-line mstsc does not raise it.
  $mstscArgs = @('/v:localhost', '/w:1920', '/h:1080')

  # localhost presents a self-signed RDP certificate; without this mstsc raises a second modal
  # ("the identity of the remote computer cannot be verified"). Per-user, reverted in teardown.
  $tscKey = 'HKCU:\Software\Microsoft\Terminal Server Client'
  New-Item -Path $tscKey -Force | Out-Null
  # StrictMode throws on reading a property the object does not have, so probe before reading.
  $existingTsc = Get-ItemProperty $tscKey -ErrorAction SilentlyContinue
  if ($existingTsc -and ($existingTsc.PSObject.Properties.Name -contains 'AuthenticationLevelOverride')) {
    $origAuthOverride = $existingTsc.AuthenticationLevelOverride
  }
  Set-ItemProperty $tscKey -Name AuthenticationLevelOverride -Value 0 -Type DWord
  $authOverrideSet = $true

  $ErrorActionPreference = 'Continue'
  & cmdkey /generic:TERMSRV/localhost /user:"$env:COMPUTERNAME\$UserName" /pass:$plain | Out-Null
  $ErrorActionPreference = 'Stop'

  $listening = Wait-RdpListener
  Step 'the RDP listener is accepting on 127.0.0.1:3389' $listening `
    $(if ($listening) { 'probe socket connected before the client was launched' } else { 'nothing listening after 40 s' })

  # ---------------------------------------------------------------- 5. disconnect owner, then log renter in
  # Disconnecting first avoids the "another user is signed in, continue?" dialog, which nothing
  # would be able to click once the console is gone.
  Progress 'PHASE: about to tsdiscon the owner'
  Note 'disconnecting the owner console session now'
  $ErrorActionPreference = 'Continue'
  & "$sys\tsdiscon.exe" $ownerSession 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  Start-Sleep -Seconds 2
  Progress 'PHASE: owner disconnected, launching client'

  # Two attempts, and if a modal appears on the invisible desktop, screenshot it rather than
  # waiting out the timeout with no idea why.
  foreach ($attempt in 1, 2) {
    Get-Process mstsc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Process mstsc -ArgumentList $mstscArgs | Out-Null
    Note "mstsc attempt $attempt launched: mstsc $($mstscArgs -join ' ')"
    $deadline = (Get-Date).AddSeconds($LogonTimeoutSeconds)
    $shot = $false
    while ((Get-Date) -lt $deadline) {
      $s = @([Iso]::Sessions() | Where-Object { $_.User -eq $UserName -and $_.State -in @('Active', 'Connected') })
      if ($s.Count -gt 0) { $renterSession = $s[0]; break }
      if (-not $shot -and (Get-Date) -gt $deadline.AddSeconds(-($LogonTimeoutSeconds - 12))) {
        $shot = $true
        $mp = @(Get-Process mstsc -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
        $dlg = @([Iso]::ListWindows([IntPtr]::Zero) | Where-Object { $mp -contains $_.Pid -and $_.Class -eq '#32770' -and $_.Visible })
        foreach ($d in $dlg) {
          Note "BLOCKING DIALOG: '$($d.Title)' $($d.W)x$($d.H)"
          Safely2 { [Iso]::Capture([Iso]::OpenDesktopByName('Default'), $d.Hwnd,
                     (Join-Path $outDir "dlg-ignore-$attempt.png"), (Join-Path $outDir "blocking-dialog-$attempt.png")) | Out-Null }
        }
      }
      Start-Sleep -Milliseconds 700
    }
    if ($renterSession) { break }
    Note "attempt $attempt produced no session; mstsc processes alive: $(@(Get-Process mstsc -ErrorAction SilentlyContinue).Count)"
  }

  if (-not $renterSession) {
    Note '--- recent Terminal Services events ---'
    foreach ($lg in 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational',
                    'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational') {
      try {
        Get-WinEvent -LogName $lg -MaxEvents 5 -ErrorAction Stop |
          ForEach-Object { Note ("  [{0}] id={1} {2}" -f $_.TimeCreated.ToString('HH:mm:ss'), $_.Id, (($_.Message -split "`r?`n")[0])) }
      } catch { Note "  ($lg unavailable)" }
    }
  }
  Step 'the throwaway account got a real logon session' ($null -ne $renterSession) `
    $(if ($renterSession) { "session $($renterSession.Id) on $($renterSession.Station), state $($renterSession.State)" } else { 'no session appeared within the timeout' })
  if (-not $renterSession) { throw 'renter never logged on' }

  Step 'it is a separate session from the owner' ([int]$renterSession.Id -ne $ownerSession) `
    "renter session $($renterSession.Id) vs owner session $ownerSession"

  # ---------------------------------------------------------------- 6. hand it the physical console
  Invoke-AsSystem -TaskName $taskTscon -Command "$sys\tscon.exe $($renterSession.Id) /dest:console"
  $got = $false
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ([int][Iso]::ConsoleSessionId() -eq [int]$renterSession.Id) { $got = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Step 'the renter session owns the physical console' $got `
    "WTSGetActiveConsoleSessionId = $([Iso]::ConsoleSessionId()), renter session = $($renterSession.Id)"

  if ($capTaskOk) { & schtasks /run /tn $taskCap 2>&1 | Out-Null }

  # ---------------------------------------------------------------- 7. collect the evidence
  Progress 'PHASE: waiting for in-session evidence'
  $evidenceFile = Join-Path $shareDir 'session-evidence.json'
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $evidenceFile)) { Start-Sleep -Milliseconds 700 }
  Progress "PHASE: evidence present = $(Test-Path $evidenceFile)"

  if (Test-Path $evidenceFile) {
    $ev = Get-Content $evidenceFile -Raw | ConvertFrom-Json
    Copy-Item $evidenceFile (Join-Path $outDir 'session-evidence.json') -Force
    if (Test-Path (Join-Path $shareDir 'session-dda.png')) {
      Copy-Item (Join-Path $shareDir 'session-dda.png') (Join-Path $outDir 'real-session-dda.png') -Force
    }
    Write-Host "`n--- from inside the renter session ---"
    $ev | Format-List | Out-String | Write-Host

    Step 'the session has its own window station' ($ev.windowStation -eq 'WinSta0' -and [int]$ev.sessionId -ne $ownerSession) `
      "WinSta0 of session $($ev.sessionId) - a distinct object from the owner's WinSta0, so the clipboard is not shared"
    Step 'the session runs its own DWM (compositing works)' ([bool]$ev.dwmInThisSession) `
      "dwm.exe per session: $($ev.dwmPids)"
    Step 'the session sees the real GPU, not a remote display adapter' `
      ($ev.ddaAdapter -notmatch 'Remote|Basic|Software|WARP' -and $ev.ddaAdapter -ne '') `
      "DXGI adapter: '$($ev.ddaAdapter)'; Win32_VideoController: $($ev.videoControllers)"
    Step 'GPU capture works inside the real session' `
      ([bool]$ev.ddaDuplicateOk -and [int]$ev.ddaFrames -gt 0 -and [bool]$ev.ddaPngWritten) `
      "mode $($ev.ddaMode), frames $($ev.ddaFrames), fps $($ev.ddaFps), colours $($ev.ddaColors), readback $($ev.ddaReadback) $($ev.ddaError)"
    Step 'the renter still cannot read the owner files' (-not [bool]$ev.ownerDocsReadable) `
      "owner Documents readable from the session: $($ev.ownerDocsReadable)"
  } else {
    Step 'evidence collected from inside the session' $false 'Capture-InSession.ps1 never wrote session-evidence.json'
    if (Test-Path (Join-Path $shareDir 'capture.log')) { Write-Host (Get-Content (Join-Path $shareDir 'capture.log') -Raw) }
  }
}
catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  Step 'run completed without an unhandled error' $false $_.Exception.Message
}
finally {
  # Nothing below may throw. A terminating error here would skip the rest of the teardown and
  # leave RDP enabled and the account alive - which is exactly what happened on the first run.
  $ErrorActionPreference = 'Continue'
  function Safely { param([string]$What, [scriptblock]$Do)
    try { & $Do } catch { Note "$What failed: $($_.Exception.Message)" } }

  Progress 'PHASE: entering teardown'
  Write-Host "`n--- teardown ---"

  # 1. give the owner the console back, first and unconditionally
  if ($renterSession) {
    Safely 'logoff renter' { & "$sys\logoff.exe" $renterSession.Id 2>&1 | Out-Null; Note "logged off renter session $($renterSession.Id)" }
    Start-Sleep -Seconds 2
  }
  Safely 'tscon owner back' { Invoke-AsSystem -TaskName $taskTscon -Command "$sys\tscon.exe $ownerSession /dest:console" | Out-Null }
  Start-Sleep -Seconds 3
  $consoleNow = -1
  Safely 'read console session' { $script:consoleNow = [int][Iso]::ConsoleSessionId() }
  Step 'the owner has the console back' ($consoleNow -eq $ownerSession) `
    "console session = $consoleNow (owner $ownerSession); the lock screen will ask for the Windows password"

  # 2. undo the machine changes
  if ($rdpEnabled) {
    Safely 'revert fDenyTSConnections' {
      Set-ItemProperty $tsKey -Name fDenyTSConnections -Value $origDeny
      Note "fDenyTSConnections restored to $origDeny"
    }
    Safely 'revert TermService start type' {
      if ((Get-Service TermService).StartType -ne $origStartType) { Set-Service TermService -StartupType $origStartType }
    }
  }
  Safely 'delete saved credential' { & cmdkey /delete:TERMSRV/localhost 2>&1 | Out-Null }
  if ($authOverrideSet) {
    Safely 'revert AuthenticationLevelOverride' {
      if ($null -eq $origAuthOverride) { Remove-ItemProperty $tscKey -Name AuthenticationLevelOverride -ErrorAction SilentlyContinue }
      else { Set-ItemProperty $tscKey -Name AuthenticationLevelOverride -Value $origAuthOverride -Type DWord }
      Note "AuthenticationLevelOverride restored ($(if ($null -eq $origAuthOverride) { 'removed' } else { $origAuthOverride }))"
    }
  }
  Safely 'clean dialog captures' { Get-ChildItem $outDir -Filter 'dlg-ignore-*.png' -ErrorAction SilentlyContinue | Remove-Item -Force }
  foreach ($t in @($taskTscon, $taskWatch, $taskCap)) { Invoke-Schtasks @('/delete', '/tn', $t, '/f') | Out-Null }
  Safely 'remove startup item' { Remove-Item $startupCmd -Force -ErrorAction SilentlyContinue }
  Safely 'kill mstsc' { Get-Process mstsc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }

  # 3. the account
  if ($sid) {
    for ($t = 1; $t -le 8; $t++) {
      $prof = $null
      Safely 'query profile' { $script:prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } }
      if (-not $prof) { break }
      try { Remove-CimInstance -InputObject $prof -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
    }
  }
  Safely 'remove local user' { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue }
  Safely 'remove share dir' { Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue }

  $userGone = $null -eq (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
  $leftover = @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$UserName*" })
  $denyNow  = (Get-ItemProperty $tsKey -Name fDenyTSConnections).fDenyTSConnections
  Step 'account, profile and RDP setting all restored' `
    ($userGone -and $leftover.Count -eq 0 -and $denyNow -eq $origDeny) `
    "user gone: $userGone; C:\Users leftovers: $(if ($leftover.Count) { ($leftover | ForEach-Object Name) -join ',' } else { 'none' }); fDenyTSConnections: $denyNow"

  ([pscustomobject]@{
    machine = $env:COMPUTERNAME
    ranAt   = (Get-Date).ToString('o')
    ownerSession = $ownerSession
    steps   = $steps
    allPassed = (@($steps | Where-Object { -not $_.pass }).Count -eq 0)
  }) | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $outDir 'real-session-report.json') -Encoding UTF8

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
}
