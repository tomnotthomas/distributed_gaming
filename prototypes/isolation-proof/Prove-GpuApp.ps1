# Prove-GpuApp.ps1 - the question Option A lives or dies on.
#
# A secondary desktop has no DWM. Prove-SwitchDesktop.ps1 showed a console window captures fine
# there at 49 fps, but a console window is not a game. This launches a real GPU application -
# Chromium, which is the same engine as the Steam client UI - on the secondary desktop as the
# throwaway user, and captures it.
#
# The page prints its own WebGL renderer string in huge text, so the captured frame answers the
# question directly: "AMD Radeon..." means hardware, "SwiftShader"/"Software" means the GPU stack
# refused and Option A is dead for games.
#
# One click, no logout, no reboot - this is the only path that matches that requirement, so it is
# worth knowing exactly where it stands. Must run elevated.

[CmdletBinding()]
param(
  [string]$UserName = 'swiff-gpu-proof',
  [string]$DesktopName = 'swiff-gpu',
  [int]$EdgeWarmupSeconds = 18,
  [int]$CaptureMs = 4000,
  [int]$WatchdogSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir   = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-gpu-proof'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$progressFile = Join-Path $outDir 'gpu-progress.txt'
Set-Content -Path $progressFile -Value "started $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function Progress { param([string]$m)
  try { Add-Content -Path $progressFile -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Note { param([string]$m) Write-Host "     $m"; Progress $m }

$steps = New-Object System.Collections.Generic.List[object]
function Step { param([string]$Claim, [bool]$Pass, [string]$Detail)
  $steps.Add([pscustomobject]@{ claim = $Claim; pass = $Pass; detail = $Detail })
  $l = "[{0}] {1} - {2}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Claim, $Detail
  Write-Host $l; Progress $l }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Must run elevated.' }

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Dda.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Edge not found' }

$hDesk = [IntPtr]::Zero
$sid = $null
$procIds = @()
$watchdog = $null
$switched = $false

try {
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $u = New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
        -FullName 'Swiff GPU-app proof' -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value
  Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue

  $hDesk = [Iso]::MakeDesktop($DesktopName)
  [Iso]::GrantWinSta($sid)
  [Iso]::GrantDesktop($hDesk, $sid)
  Note "desktop WinSta0\$DesktopName created and granted to $UserName"

  New-Item -ItemType Directory -Force -Path $shareDir, (Join-Path $shareDir 'edge') | Out-Null
  # Everyone needs write access; Edge stores its profile here as the throwaway user.
  & icacls $shareDir /grant "${UserName}:(OI)(CI)F" /T 2>&1 | Out-Null

  $page = Join-Path $shareDir 'gpu.html'
  Set-Content -Path $page -Encoding UTF8 -Value @'
<!doctype html><meta charset="utf-8"><title>gpu</title>
<style>
 html,body{margin:0;height:100%;background:#000;color:#fff;
   font:700 40px/1.25 Consolas,monospace;overflow:hidden}
 #r{position:absolute;top:24px;left:24px;right:24px;z-index:2;text-shadow:0 0 8px #000}
 .big{font-size:64px;color:#0f0}
 .bad{color:#f33}
 canvas{position:absolute;inset:0;width:100%;height:100%;z-index:1}
</style>
<canvas id=c></canvas>
<div id=r>starting...</div>
<script>
const c=document.getElementById('c'),out=document.getElementById('r');
c.width=innerWidth;c.height=innerHeight;
const gl=c.getContext('webgl')||c.getContext('experimental-webgl');
let renderer='NO WEBGL CONTEXT',vendor='';
if(gl){
  const dbg=gl.getExtension('WEBGL_debug_renderer_info');
  renderer=dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  vendor=dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR);
}
const soft=/swiftshader|software|llvmpipe|basic|warp/i.test(renderer);
out.innerHTML='<div class=big>WEBGL RENDERER</div>'+
  '<div class="big '+(soft?'bad':'')+'">'+renderer+'</div>'+
  '<div>'+vendor+'</div><div>'+(soft?'SOFTWARE FALLBACK':'HARDWARE')+'</div>'+
  '<div id=f>frame 0</div>';
let n=0;
function tick(){
  n++;
  if(gl){ const t=n*0.03;
    gl.viewport(0,0,c.width,c.height);
    gl.clearColor(0.5+0.5*Math.sin(t),0.15,0.5+0.5*Math.cos(t),1);
    gl.clear(gl.COLOR_BUFFER_BIT); }
  const f=document.getElementById('f'); if(f)f.textContent='frame '+n;
  requestAnimationFrame(tick);
}
tick();
</script>
'@

  $args = "--user-data-dir=`"$shareDir\edge`" --no-first-run --no-default-browser-check " +
          "--disable-sync --disable-features=msEdgeWelcomePage --start-maximized " +
          "--app=`"file:///$($page -replace '\\','/')`""
  $pidEdge = [Iso]::LaunchAs($UserName, $plain, "`"$edge`" $args", "WinSta0\$DesktopName", (Split-Path $edge))
  $procIds += $pidEdge
  Note "Edge launched as $UserName on the secondary desktop (pid $pidEdge)"
  Start-Sleep -Seconds $EdgeWarmupSeconds

  $edgeProcs = @(Get-Process msedge -ErrorAction SilentlyContinue)
  $wins = @([Iso]::ListWindows($hDesk) | Where-Object { $_.W -gt 200 -and $_.H -gt 200 })
  Step 'Chromium starts at all on a secondary desktop' ($wins.Count -gt 0) `
    "msedge processes: $($edgeProcs.Count); windows >200px on that desktop: $($wins.Count) $(($wins | ForEach-Object { "'$($_.Title)' $($_.W)x$($_.H)" }) -join ', ')"

  $watchdog = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $root 'Restore-Desktop.ps1')`"",
    '-AfterSeconds', $WatchdogSeconds)
  Note "watchdog pid $($watchdog.Id), $WatchdogSeconds s"

  Progress 'PHASE: switching desktop'
  [Iso]::Switch($hDesk)
  $switched = $true
  Start-Sleep -Seconds 3
  Step 'the monitor shows the secondary desktop' ([Iso]::InputDesktopName() -eq $DesktopName) "InputDesktop = $([Iso]::InputDesktopName())"

  Progress 'PHASE: capturing'
  $png = Join-Path $outDir 'gpu-app-on-secondary-desktop.png'
  $dda = [Dda]::RunOnThread($hDesk, $CaptureMs, $png)
  Progress 'PHASE: captured'
  Note ("DDA duplicateOk={0} {1}x{2} frames={3} fps={4} png={5} colours={6} err='{7}'" -f `
    $dda.DuplicateOk, $dda.Width, $dda.Height, $dda.FramesAcquired, [math]::Round($dda.Fps,1),
    $dda.PngWritten, $dda.Colors, $dda.Error)
  Step 'the GPU app renders and is captured' `
    ([bool]$dda.DuplicateOk -and [int]$dda.FramesAcquired -gt 0 -and [bool]$dda.PngWritten -and [int]$dda.Colors -ge 8) `
    "frames=$($dda.FramesAcquired) fps=$([math]::Round($dda.Fps,1)) colours=$($dda.Colors) -> $(Split-Path $png -Leaf)"
}
catch { Write-Host "ERROR: $($_.Exception.Message)"; Progress "ERROR: $($_.Exception.Message)"
        Step 'run completed without an unhandled error' $false $_.Exception.Message }
finally {
  $ErrorActionPreference = 'Continue'
  Progress 'PHASE: teardown'
  function Safely { param([string]$W, [scriptblock]$D) try { & $D } catch { Note "$W failed: $($_.Exception.Message)" } }

  if ($switched) { Safely 'switch back' { [Iso]::SwitchToByName('Default') } }
  $restored = 'unknown'; Safely 'read desktop' { $script:restored = [Iso]::InputDesktopName() }
  Step 'the owner gets the screen back' ($restored -eq 'Default') "InputDesktop = $restored"

  if ($watchdog) { Safely 'kill watchdog' { Stop-Process -Id $watchdog.Id -Force -ErrorAction SilentlyContinue } }
  Safely 'kill renter processes' {
    Get-CimInstance Win32_Process | ForEach-Object {
      $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      if ($o -and $o.User -eq $UserName) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } }
  Start-Sleep -Seconds 2
  if ($hDesk -ne [IntPtr]::Zero) { Safely 'close desktop' { [Iso]::KillDesktop($hDesk) } }
  if ($sid) { Safely 'revoke ACEs' { [Iso]::RevokeWinSta($sid) | Out-Null } }

  if ($sid) {
    for ($t = 1; $t -le 8; $t++) {
      $p = $null; Safely 'query profile' { $script:p = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } }
      if (-not $p) { break }
      try { Remove-CimInstance -InputObject $p -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
    }
  }
  Safely 'remove user' { Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue }
  Safely 'remove share' { Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue }

  $userGone = $null -eq (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)
  $left = @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$UserName*" })
  Step 'account and profile removed' ($userGone -and $left.Count -eq 0) `
    "user gone: $userGone; leftovers: $(if ($left.Count) { ($left | ForEach-Object Name) -join ',' } else { 'none' })"

  Write-Host "`n================ VERDICT ================"
  foreach ($s in $steps) { Write-Host ("{0}  {1}" -f $(if ($s.pass) { 'PASS' } else { 'FAIL' }), $s.claim) }
}
