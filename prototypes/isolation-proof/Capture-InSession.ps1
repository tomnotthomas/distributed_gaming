# Runs INSIDE the renter's real logon session, launched by a scheduled task registered to that
# account with /it (interactive). Everything here is evidence about the session it finds itself in.
#
# The decisive field is `ddaAdapter`. In an RDP session without the console handoff this reads
# "Microsoft Remote Display Adapter" (software rendering, useless for games). After
# `tscon <id> /dest:console` it should read the real GPU.
param(
  [Parameter(Mandatory = $true)][string]$ShareDir,
  [int]$CaptureMs = 4000,
  [int]$WaitForConsoleSeconds = 60,
  [string]$ExpectUser = '',
  # The owner's profile folder, passed in by the caller (the owner knows its own path). The renter
  # tries to read the owner's Documents from here as the isolation probe. Empty/absent => not tested.
  [string]$OwnerProfile = ''
)

$ErrorActionPreference = 'Continue'

# This is also dropped into the all-users Startup folder, so it can fire for the owner if teardown
# is interrupted. Refuse to capture anyone but the proof account.
if ($ExpectUser -and $env:USERNAME -ne $ExpectUser) { exit 0 }

$o = [ordered]@{}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition (Get-Content (Join-Path $ShareDir 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'
  Add-Type -TypeDefinition (Get-Content (Join-Path $ShareDir 'Dda.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

  $me   = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sess = (Get-Process -Id $PID).SessionId

  # This may start before the console handoff has happened - as an RDP session it would see the
  # Microsoft Remote Display Adapter and prove nothing. Wait until this session owns the console,
  # so the launch order does not matter.
  $waited = 0
  while ($sess -ne [int][Iso]::ConsoleSessionId() -and $waited -lt $WaitForConsoleSeconds) {
    Start-Sleep -Milliseconds 500; $waited += 0.5
  }
  $o.waitedForConsoleSeconds = $waited

  $o.ranAt         = (Get-Date).ToString('o')
  $o.user          = $me.Name
  $o.isAdmin       = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $o.sessionId     = $sess
  $o.consoleId     = [int][Iso]::ConsoleSessionId()
  $o.isConsole     = ($sess -eq [int][Iso]::ConsoleSessionId())
  $o.windowStation = [Iso]::ProcessWindowStationName()
  $o.inputDesktop  = [Iso]::InputDesktopName()
  $o.userProfile   = $env:USERPROFILE

  # DWM is the thing a secondary desktop could not give us. One dwm.exe per composited session.
  $dwmAll = @(Get-Process dwm -ErrorAction SilentlyContinue)
  $dwmMine = @($dwmAll | Where-Object { $_.SessionId -eq $sess })
  $o.dwmInThisSession = ($dwmMine.Count -gt 0)
  $o.dwmPids          = ($dwmAll | ForEach-Object { "$($_.Id)@session$($_.SessionId)" }) -join ', '

  # Can this session see the owner's data at all?
  # Report three states, not two: 'not-tested' when we were given no owner path or it doesn't exist,
  # so a machine-specific missing path can never masquerade as a passed isolation check. Only an
  # actual successful read counts as $true; an explicit access denial counts as $false (isolated).
  $ownerDocs = if ($OwnerProfile) { Join-Path $OwnerProfile 'Documents' } else { '' }
  if (-not $ownerDocs -or -not (Test-Path $ownerDocs)) {
    $o.ownerDocsReadable = 'not-tested'
    $o.ownerDocsNote = "owner Documents path not provided or absent: '$ownerDocs'"
  } else {
    try {
      Get-ChildItem $ownerDocs -ErrorAction Stop | Out-Null
      $o.ownerDocsReadable = $true          # read succeeded - ISOLATION BREACH
    } catch {
      $o.ownerDocsReadable = $false         # access denied - isolated as intended
      $o.ownerDocsNote = $_.Exception.GetType().Name
    }
  }

  $o.videoControllers = ((Get-CimInstance Win32_VideoController | ForEach-Object Name) -join '; ')

  # The capture itself.
  $png = Join-Path $ShareDir 'session-dda.png'
  $r = [Dda]::RunOnThread([IntPtr]::Zero, $CaptureMs, $png)
  $o.ddaAdapter      = $r.Adapter
  $o.ddaDeviceOk     = $r.DeviceOk
  $o.ddaDuplicateOk  = $r.DuplicateOk
  $o.ddaMode         = "$($r.Width)x$($r.Height)"
  $o.ddaFrames       = $r.FramesAcquired
  $o.ddaTimeouts     = $r.Timeouts
  $o.ddaFps          = [math]::Round($r.Fps, 1)
  $o.ddaReadback     = $r.ReadbackPath
  $o.ddaPngWritten   = $r.PngWritten
  $o.ddaColors       = $r.Colors
  $o.ddaStage        = $r.Stage
  $o.ddaError        = $r.Error
  $o.ok = $true
}
catch {
  $o.ok = $false
  $o.error = $_.Exception.ToString()
}

$o | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ShareDir 'session-evidence.json') -Encoding UTF8
