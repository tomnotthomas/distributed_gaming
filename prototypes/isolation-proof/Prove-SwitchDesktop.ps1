# Prove-SwitchDesktop.ps1 - the second half of the isolation question.
#
# Prove-Isolation.ps1 showed that a renter can be put in a throwaway standard account on its own
# desktop, and that the desktop can be read per-window. What it could NOT do was capture the
# desktop as a whole: an inactive desktop has no display surface, so BitBlt came back black.
#
# This script tests the fix: SwitchDesktop() makes the session desktop the one the monitor shows,
# which should give it a real display surface. It then measures what capture that buys:
#
#   A. GDI  - CreateDC("DISPLAY") + BitBlt against the now-active isolated desktop
#   B. GPU  - DXGI Desktop Duplication, the path a real encoder would use
#
# The screen goes to the session desktop for a few seconds. A detached watchdog switches it back
# even if this script dies, and the finally block switches back on every exit path.
#
# Must run elevated.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-switch-proof',
  [string]$DesktopName = 'swiff-switch',
  [int]$CaptureMs = 3000,
  [int]$WatchdogSeconds = 45,
  [switch]$Busy   # redraw the session desktop as fast as it can, to measure capture throughput
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-switch-proof'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$steps = New-Object System.Collections.Generic.List[object]
function Step {
  param([string]$Claim, [bool]$Pass, [string]$Detail)
  $steps.Add([pscustomobject]@{ claim = $Claim; pass = $Pass; detail = $Detail })
  Write-Host ("[{0}] {1} - {2}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Claim, $Detail)
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Must run elevated.'
}

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Dda.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$hDesk = [IntPtr]::Zero
$sid = $null
$procIds = @()
$watchdog = $null
$switched = $false

try {
  # ---------------------------------------------------------------- session account
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $u = New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
        -FullName 'Swiff switch-desktop proof' -Description 'Temporary; created by Prove-SwitchDesktop.ps1' `
        -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value
  Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue

  $hDesk = [Iso]::MakeDesktop($DesktopName)
  [Iso]::GrantWinSta($sid)
  [Iso]::GrantDesktop($hDesk, $sid)

  # Something to look at on the session desktop, so a captured frame is unmistakably that desktop.
  New-Item -ItemType Directory -Force -Path $shareDir | Out-Null
  $runner = Join-Path $shareDir 'runner.cmd'
  $pace = $(if ($Busy) { '' } else { 'timeout /t 1 /nobreak >nul' })
  Set-Content -Path $runner -Encoding ASCII -Value @"
@echo off
title SWIFF SESSION DESKTOP
mode con: cols=100 lines=40
:loop
cls
echo ###############################################################
echo #                                                             #
echo #   THIS IS THE RENTER SESSION DESKTOP - WinSta0\$DesktopName
echo #                                                             #
echo ###############################################################
echo.
echo Frame time: %TIME%
echo.
$pace
goto loop
"@
  $sys = Join-Path $env:WINDIR 'System32'
  $pidRenter = [Iso]::LaunchAs($UserName, $plain, "`"$sys\conhost.exe`" `"$sys\cmd.exe`" /k `"$runner`"", "WinSta0\$DesktopName", $sys)
  $procIds += $pidRenter
  Start-Sleep -Seconds 3

  $o = Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId=$pidRenter") -MethodName GetOwner
  Step 'session process running in the throwaway account' ("$($o.Domain)\$($o.User)" -match [regex]::Escape($UserName)) "$($o.Domain)\$($o.User) (pid $pidRenter)"

  $before = [Iso]::InputDesktopName()
  Step 'input desktop before switch is the owner desktop' ($before -eq 'Default') "InputDesktop = $before"

  # ---------------------------------------------------------------- the switch
  $watchdog = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$(Join-Path $root 'Restore-Desktop.ps1')`"",
    '-AfterSeconds', $WatchdogSeconds)
  Write-Host "watchdog pid $($watchdog.Id) will force the screen back in $WatchdogSeconds s"

  [Iso]::Switch($hDesk)
  $switched = $true
  Start-Sleep -Milliseconds 1200

  $after = [Iso]::InputDesktopName()
  Step 'the monitor is now showing the session desktop' ($after -eq $DesktopName) "InputDesktop = $after"

  # ---------------------------------------------------------------- A. GDI capture
  $wins = [Iso]::ListWindows($hDesk) | Where-Object { $_.Pid -eq $pidRenter -and $_.W -gt 50 }
  $targetHwnd = if ($wins) { ($wins | Select-Object -First 1).Hwnd } else { [IntPtr]::Zero }
  $gdiFull = Join-Path $outDir 'switched-gdi-full.png'
  $gdiWin  = Join-Path $outDir 'switched-gdi-window.png'
  $shots = [Iso]::Capture($hDesk, $targetHwnd, $gdiFull, $gdiWin)
  $gdi = $shots[0]
  Step 'GDI full-desktop capture works once the desktop is active' ($gdi.Ok -and $gdi.Colors -ge 8) `
    "ok=$($gdi.Ok) distinctColors=$($gdi.Colors) $($gdi.Note)  (was: black, 1 colour, while inactive)"

  # ---------------------------------------------------------------- B. GPU capture
  $ddaPng = Join-Path $outDir 'switched-dda.png'
  $dda = [Dda]::RunOnThread($hDesk, $CaptureMs, $ddaPng)
  Write-Host ("DDA: duplicateOk={0} mode={1}x{2} frames={3} timeouts={4} fps={5} readback='{6}' png={7} colors={8} stage='{9}' err='{10}'" -f `
    $dda.DuplicateOk, $dda.Width, $dda.Height, $dda.FramesAcquired, $dda.Timeouts,
    [math]::Round($dda.Fps,1), $dda.ReadbackPath, $dda.PngWritten, $dda.Colors, $dda.Stage, $dda.Error)
  Step 'DXGI Desktop Duplication attaches to the session desktop' $dda.DuplicateOk `
    "DuplicateOutput: $(if ($dda.DuplicateOk) { 'succeeded' } else { $dda.Error })"
  Step 'GPU capture delivers frames from the session desktop' (($dda.FramesAcquired -gt 0) -and $dda.PngWritten -and ($dda.Colors -ge 8)) `
    "frames=$($dda.FramesAcquired) fps=$([math]::Round($dda.Fps,1)) distinctColors=$($dda.Colors) via $($dda.ReadbackPath)"
}
finally {
  # ---------------------------------------------------------------- give the screen back first
  if ($switched) {
    try { [Iso]::SwitchToByName('Default'); Write-Host 'switched back to Default' }
    catch { Write-Host "SWITCH BACK FAILED: $($_.Exception.Message) - watchdog will handle it" }
  }
  $restored = 'unknown'
  try { $restored = [Iso]::InputDesktopName() } catch {}
  Step 'the owner gets the screen back' ($restored -eq 'Default') "InputDesktop = $restored"

  if ($watchdog) { Stop-Process -Id $watchdog.Id -Force -ErrorAction SilentlyContinue }

  foreach ($p in $procIds) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  try {
    Get-CimInstance Win32_Process | ForEach-Object {
      $ow = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      if ($ow -and $ow.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  } catch {}

  if ($hDesk -ne [IntPtr]::Zero) { [Iso]::KillDesktop($hDesk) }
  if ($sid) { try { [Iso]::RevokeWinSta($sid) | Out-Null } catch {} }
  Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue

  if ($sid) {
    for ($t = 1; $t -le 6; $t++) {
      $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
      if (-not $prof) { break }
      try { Remove-CimInstance -InputObject $prof -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
    }
  }
  try { Remove-LocalUser -Name $UserName -ErrorAction Stop } catch {}
  $userGone = $null -eq (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
  $leftover = @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$UserName*" })
  Step 'account and profile removed' ($userGone -and $leftover.Count -eq 0) `
    "user: $(if ($userGone) { 'gone' } else { 'STILL PRESENT' }); C:\Users leftovers: $(if ($leftover.Count) { ($leftover | ForEach-Object Name) -join ',' } else { 'none' })"

  ([pscustomobject]@{
    machine = $env:COMPUTERNAME
    gpu     = (Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)
    ranAt   = (Get-Date).ToString('o')
    steps   = $steps
    allPassed = (@($steps | Where-Object { -not $_.pass }).Count -eq 0)
  }) | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $outDir 'switch-report.json') -Encoding UTF8

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
}
