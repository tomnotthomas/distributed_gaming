# Prove-Isolation.ps1 - proves the four load-bearing claims of the Swiff host isolation model
# on this physical machine:
#
#   1. create a standard (non-administrator) local Windows account
#   2. start a process inside that account, on its own desktop
#   3. capture that desktop
#   4. delete the account (and its profile) afterwards
#
# Must run elevated. Everything it creates is torn down in the finally block.
# Artifacts land in .\out\ : PNG captures, evidence.txt, report.json.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-iso-proof',
  [string]$DesktopName = 'swiff-iso',
  [int]$SettleSeconds = 6,
  [switch]$KeepAccount   # diagnostics only; default is always to delete
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir  = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-iso-proof'   # readable+writable by the standard account
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$steps = New-Object System.Collections.Generic.List[object]
function Step {
  param([string]$Claim, [bool]$Pass, [string]$Detail)
  $steps.Add([pscustomobject]@{ claim = $Claim; pass = $Pass; detail = $Detail })
  $mark = if ($Pass) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1} - {2}" -f $mark, $Claim, $Detail)
}

# ---------------------------------------------------------------- preflight
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Must run elevated (account creation needs administrator).' }

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) `
         -ReferencedAssemblies 'System.Drawing'

Write-Host "Host account : $($id.Name)  (session $((Get-Process -Id $PID).SessionId))"
Write-Host "Proof account: $UserName    Desktop: WinSta0\$DesktopName`n"

$hDesk = [IntPtr]::Zero
$sid = $null
$procIds = @()

$proofCompleted = $false
$marker = $null

try {
  # ------------------------------------------------- 1. create a standard account
  # Refuse to touch a pre-existing account of this name - it might be a real one, not our leftover.
  # Clearing an aborted run is Reset-ProofState.ps1's job, which checks the account is ours first.
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
    throw "an account named '$UserName' already exists - refusing to delete it. Run Reset-ProofState.ps1 to clear a prior run."
  }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $pw = ConvertTo-SecureString $plain -AsPlainText -Force

  $u = New-LocalUser -Name $UserName -Password $pw -FullName 'Swiff isolation proof' `
        -Description 'Temporary account created by Prove-Isolation.ps1' `
        -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value

  # Standard user = member of Users, and NOT of Administrators.
  Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue
  $adminMembers = (Get-LocalGroupMember -Group 'Administrators' | ForEach-Object { $_.SID.Value })
  $inAdmins = $adminMembers -contains $sid
  $groups = (Get-LocalGroup | Where-Object {
      try { (Get-LocalGroupMember -Group $_ -ErrorAction Stop | ForEach-Object { $_.SID.Value }) -contains $sid }
      catch { $false }
    } | ForEach-Object Name) -join ', '

  Step 'account exists' ($null -ne (Get-LocalUser -Name $UserName)) "SID $sid"
  Step 'account is NOT an administrator' (-not $inAdmins) "groups: $groups"

  # ------------------------------------------------- 2. own desktop + process inside it
  $hDesk = [Iso]::MakeDesktop($DesktopName)
  [Iso]::GrantWinSta($sid)
  [Iso]::GrantDesktop($hDesk, $sid)
  Step 'separate desktop object created' ($hDesk -ne [IntPtr]::Zero) "WinSta0\$DesktopName, access granted to the proof account only"

  # A probe the renter-side process runs; it reports its own identity and what it can
  # reach of the owner. It never prints file contents - only whether a read succeeded.
  New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
  $ownerProfile = $env:USERPROFILE
  $ownerSecrets = Join-Path $root '..\..\.env' | Resolve-Path -ErrorAction SilentlyContinue
  if (-not $ownerSecrets) { $ownerSecrets = Join-Path $ownerProfile 'NTUSER.DAT' }

  # The authoritative isolation check needs a target that DEFINITELY exists and is readable by the
  # owner but locked to the owner - otherwise a merely-absent path (e.g. no Chrome installed) makes
  # "denied" ambiguous and could pass a hollow check. Seed one, owner + SYSTEM + Admins only.
  $marker = Join-Path $ownerProfile ("swiff-owner-secret-" + [guid]::NewGuid().ToString('N') + ".txt")
  Set-Content -Path $marker -Value "OWNER-ONLY SECRET $([guid]::NewGuid())" -Encoding ASCII
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)   # drop inherited ACEs (which grant Users read)
  foreach ($who in $id.User.Value, 'S-1-5-18', 'S-1-5-32-544') {   # owner, SYSTEM, Administrators
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      (New-Object System.Security.Principal.SecurityIdentifier($who)), 'FullControl', 'Allow')))
  }
  Set-Acl -Path $marker -AclObject $acl
  # Confirm the owner really can read it, so a denial from the renter is meaningful.
  $ownerCanRead = $false
  try { Get-Content $marker -ErrorAction Stop | Out-Null; $ownerCanRead = $true } catch {}
  Step 'owner-only marker seeded and readable by the owner' $ownerCanRead "the renter probe reads this exact file"

  $probe = @"
@echo off
echo ============== SWIFF ISOLATION PROOF ==============
echo.
echo -- who am I --
whoami
echo.
echo -- am I an administrator? --
whoami /groups | findstr /i "S-1-5-32-544" >nul 2>&1
if errorlevel 1 (echo   NOT in Administrators  [OK]) else (echo   IN Administrators  [ISOLATION FAILED])
echo.
echo -- my profile --
echo   USERPROFILE=%USERPROFILE%
echo.
echo -- authoritative check: the owner-only marker file (known to exist) --
type "$marker" >nul 2>&1
if errorlevel 1 (echo   owner marker file    : denied  [OK]) else (echo   owner marker file    : READABLE  [ISOLATION FAILED])
echo.
echo -- secondary checks (a path may simply be absent) --
dir "$ownerProfile\Documents" >nul 2>&1
if errorlevel 1 (echo   owner Documents      : denied  [OK]) else (echo   owner Documents      : READABLE  [ISOLATION FAILED])
dir "$ownerProfile\Desktop" >nul 2>&1
if errorlevel 1 (echo   owner Desktop        : denied  [OK]) else (echo   owner Desktop        : READABLE  [ISOLATION FAILED])
type "$ownerSecrets" >nul 2>&1
if errorlevel 1 (echo   owner secrets file   : denied  [OK]) else (echo   owner secrets file   : READABLE  [ISOLATION FAILED])
dir "$ownerProfile\AppData\Local\Google" >nul 2>&1
if errorlevel 1 (echo   owner browser data   : denied  [OK]) else (echo   owner browser data   : READABLE  [ISOLATION FAILED])
echo.
echo -- what desktop am I on? --
echo   (window enumeration is done from the host side)
echo.
echo ===================================================
"@
  $probePath = Join-Path $shareDir 'probe.cmd'
  $runnerPath = Join-Path $shareDir 'runner.cmd'
  $evidencePath = Join-Path $shareDir 'evidence.txt'
  Set-Content -Path $probePath -Value $probe -Encoding ASCII
  Set-Content -Path $runnerPath -Encoding ASCII -Value @"
@echo off
title SWIFF ISOLATION PROOF
mode con: cols=78 lines=32
call "%~dp0probe.cmd" > "%~dp0evidence.txt" 2>&1
type "%~dp0evidence.txt"
echo.
echo [window held open on WinSta0\$DesktopName for capture]
"@

  # Try the legacy console host first (a guaranteed GDI window), then plain cmd, then charmap.
  $sys = Join-Path $env:WINDIR 'System32'
  $candidates = @(
    @{ name = 'conhost + cmd'; cmd = "`"$sys\conhost.exe`" `"$sys\cmd.exe`" /k `"$runnerPath`"" },
    @{ name = 'cmd';           cmd = "`"$sys\cmd.exe`" /k `"$runnerPath`"" },
    @{ name = 'charmap';       cmd = "`"$sys\charmap.exe`"" }
  )

  $target = $null
  $launched = @()
  foreach ($c in $candidates) {
    try {
      $pid2 = [Iso]::LaunchAs($UserName, $plain, $c.cmd, "WinSta0\$DesktopName", $sys)
      $procIds += $pid2
      $launched += "$($c.name) -> pid $pid2"
      Start-Sleep -Milliseconds ($SettleSeconds * 400)
      $wins = [Iso]::ListWindows($hDesk) | Where-Object { $_.Pid -eq $pid2 -and $_.W -gt 50 -and $_.H -gt 50 }
      if ($wins) { $target = $wins | Select-Object -First 1; break }
    } catch {
      $launched += "$($c.name) -> failed: $($_.Exception.Message)"
    }
  }
  Write-Host ("launch attempts: " + ($launched -join ' | '))

  # Confirm the process really is running as the proof account, not as the owner.
  $owners = foreach ($p in $procIds) {
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
    if ($ci) {
      $o = Invoke-CimMethod -InputObject $ci -MethodName GetOwner -ErrorAction SilentlyContinue
      "$($ci.Name)#$p=$($o.Domain)\$($o.User)"
    }
  }
  $ranAsProofUser = ($owners -join ' ') -match [regex]::Escape($UserName)
  Step 'process runs inside the standard account' $ranAsProofUser ($owners -join ', ')

  Start-Sleep -Seconds $SettleSeconds

  # ------------------------------------------------- isolation: who sees which windows
  $isoWins  = [Iso]::ListWindows($hDesk)
  $hostWins = [Iso]::ListWindows([IntPtr]::Zero)   # NULL = the calling thread's desktop (Default)

  $isoTitles  = ($isoWins  | Where-Object { $_.Title } | ForEach-Object { "$($_.Title) [$($_.Class)] pid=$($_.Pid)" })
  $hostTitles = ($hostWins | Where-Object { $_.Title -and $_.Visible } | ForEach-Object { "$($_.Title) [$($_.Class)] pid=$($_.Pid)" })

  $isoPids  = @($isoWins  | ForEach-Object { $_.Pid } | Sort-Object -Unique)
  $hostPids = @($hostWins | ForEach-Object { $_.Pid } | Sort-Object -Unique)
  $overlap  = @($isoPids | Where-Object { $hostPids -contains $_ })

  Step 'the two desktops share no windows' ($overlap.Count -eq 0) `
    ("isolated desktop: $(@($isoWins).Count) windows / $($isoPids.Count) procs; owner desktop: $(@($hostWins).Count) windows / $($hostPids.Count) procs; overlap: $($overlap.Count)")

  $renterProcOnOwnerDesktop = @($hostWins | Where-Object { $procIds -contains $_.Pid })
  Step 'renter windows are invisible on the owner desktop' ($renterProcOnOwnerDesktop.Count -eq 0) `
    "renter pids found on owner desktop: $($renterProcOnOwnerDesktop.Count)"

  # ------------------------------------------------- 3. capture that desktop
  $fullPng = Join-Path $outDir 'isolated-desktop-full.png'
  $winPng  = Join-Path $outDir 'isolated-desktop-window.png'
  $targetHwnd = if ($target) { $target.Hwnd } else { [IntPtr]::Zero }
  $shots = [Iso]::Capture($hDesk, $targetHwnd, $fullPng, $winPng)

  foreach ($s in $shots) {
    if ($null -ne $s) { Write-Host ("capture {0}: ok={1} colors={2} note={3}" -f (Split-Path $s.Path -Leaf), $s.Ok, $s.Colors, $s.Note) }
  }
  # A capture counts only if it produced real pixels, not a black rectangle.
  $good = @($shots | Where-Object { $null -ne $_ -and $_.Ok -and $_.Colors -ge 8 })
  Step 'the isolated desktop can be captured' ($good.Count -gt 0) `
    (($shots | Where-Object { $null -ne $_ } | ForEach-Object { "$(Split-Path $_.Path -Leaf): ok=$($_.Ok) distinctColors=$($_.Colors) $($_.Note)" }) -join ' | ')

  # ------------------------------------------------- the probe's own verdict
  $evidence = ''
  if (Test-Path $evidencePath) {
    $evidence = Get-Content $evidencePath -Raw
    Copy-Item $evidencePath (Join-Path $outDir 'evidence.txt') -Force
    Write-Host "`n--- what the renter-side process could see ---"
    Write-Host $evidence
  }
  $noBreach = ($evidence -notmatch 'ISOLATION FAILED')
  Step 'renter process cannot read the owner data it tried' ($noBreach -and $evidence -ne '') `
    $(if ($evidence -eq '') { 'probe produced no output' } else { 'probe reported no readable owner data' })

  $proofCompleted = $true
}
finally {
  # Remove the owner-only marker file the probe targeted.
  if ($marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
  # ------------------------------------------------- 4. delete everything
  Write-Host "`n--- teardown ---"
  foreach ($p in $procIds) {
    try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "killed pid $p" }
    catch { Write-Host "pid $p already gone" }
  }
  # Any stray process the renter started inside the account.
  try {
    Get-CimInstance Win32_Process | ForEach-Object {
      $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      if ($o -and $o.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  } catch {}

  if ($hDesk -ne [IntPtr]::Zero) { [Iso]::KillDesktop($hDesk); Write-Host "closed desktop WinSta0\$DesktopName" }
  if ($sid) { try { $n = [Iso]::RevokeWinSta($sid); Write-Host "removed $n window-station ACE(s)" } catch { Write-Host "ACE revoke: $($_.Exception.Message)" } }

  Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue

  $profileGone = $true
  $userGone = $true
  if (-not $KeepAccount) {
    # The profile is still loaded for a moment after the logon session ends, so retry.
    if ($sid) {
      for ($try = 1; $try -le 6; $try++) {
        $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
        if (-not $prof) { break }
        try {
          $lp = $prof.LocalPath
          Remove-CimInstance -InputObject $prof -ErrorAction Stop
          Write-Host "removed profile $lp"
          break
        } catch {
          if ($try -eq 6) { Write-Host "profile removal: $($_.Exception.Message)" }
          Start-Sleep -Seconds 1
        }
      }
    }
    try { Remove-LocalUser -Name $UserName -ErrorAction Stop; Write-Host "deleted account $UserName" }
    catch { Write-Host "account removal: $($_.Exception.Message)" }

    Start-Sleep -Milliseconds 500
    $userGone = $null -eq (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
    $leftover = @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like "$UserName*" })
    $profileGone = ($leftover.Count -eq 0)
    $profileLeft = $(if ($leftover.Count) { ($leftover | ForEach-Object FullName) -join ', ' } else { 'none' })

    Step 'account deleted afterwards' $userGone ("Get-LocalUser: " + $(if ($userGone) { 'not found' } else { 'STILL PRESENT' }))
    Step 'profile directory removed' $profileGone "leftover under C:\Users: $profileLeft"
  }

  $report = [pscustomobject]@{
    machine   = $env:COMPUTERNAME
    os        = (Get-CimInstance Win32_OperatingSystem).Caption
    build     = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    ranAt     = (Get-Date).ToString('o')
    hostUser  = $id.Name
    proofUser = $UserName
    desktop   = "WinSta0\$DesktopName"
    steps     = $steps
    allPassed = ($proofCompleted -and (@($steps | Where-Object { -not $_.pass }).Count -eq 0))
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $outDir 'report.json') -Encoding UTF8

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
  Write-Host ("ALL CLAIMS PROVEN: {0}" -f $report.allPassed)
  Write-Host "artifacts: $outDir"
}
