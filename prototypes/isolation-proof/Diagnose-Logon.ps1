# Why does the loopback RDP logon never produce a session?
#
# Prove-RealSession.ps1 disconnects the owner before launching the client, so any dialog mstsc
# raises is invisible and unanswerable. This does the same setup but leaves the owner's console
# ALONE, lets mstsc put its windows on the visible desktop, and screenshots every one of them via
# PrintWindow so the error text can actually be read.
#
# It never clicks anything and never disconnects anyone. Must run elevated.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir   = Join-Path $root 'out'
$shareDir = Join-Path $env:PUBLIC 'swiff-session-proof'
$UserName = 'swiff-session-proof'
$tsKey    = 'HKLM:\System\CurrentControlSet\Control\Terminal Server'
New-Item -ItemType Directory -Force -Path $outDir, $shareDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

$origDeny = (Get-ItemProperty $tsKey -Name fDenyTSConnections).fDenyTSConnections
# Snapshot the service so teardown restores it exactly, rather than leaving a machine where RDP had
# been off looking as if it were configured for it.
$svc = Get-Service TermService
$origStartType = $svc.StartType
$origRunning = ($svc.Status -eq 'Running')
$startedByUs = $false
$sid = $null

function Shoot {
  param([string]$Tag)
  $procs = @(Get-Process mstsc, CredentialUIBroker, consent -ErrorAction SilentlyContinue)
  $pids  = @($procs | ForEach-Object { [uint32]$_.Id })
  $wins  = @([Iso]::ListWindows([IntPtr]::Zero) | Where-Object { $pids -contains $_.Pid -and $_.W -gt 80 -and $_.H -gt 40 })
  Write-Host "[$Tag] mstsc/cred windows: $($wins.Count)"
  $i = 0
  foreach ($w in $wins) {
    $i++
    $p = Join-Path $outDir ("mstsc-$Tag-$i.png")
    try {
      $s = [Iso]::Capture([Iso]::OpenDesktopByName('Default'), $w.Hwnd, (Join-Path $outDir "ignore-$Tag-$i.png"), $p)
      Write-Host ("  '{0}' [{1}] {2}x{3} visible={4} -> {5} colours={6}" -f $w.Title, $w.Class, $w.W, $w.H, $w.Visible, (Split-Path $p -Leaf), $s[1].Colors)
    } catch { Write-Host "  capture failed for '$($w.Title)': $($_.Exception.Message)" }
  }
  if ($wins.Count -eq 0 -and $procs.Count -gt 0) {
    Write-Host "  processes alive but no sizeable windows: $(($procs | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', ')"
  }
}

try {
  if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $UserName }
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = [Convert]::ToBase64String($bytes) + '!aA9'
  $u = New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) `
        -FullName 'Swiff logon diagnosis' -PasswordNeverExpires -UserMayNotChangePassword
  $sid = $u.SID.Value
  Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $UserName -ErrorAction SilentlyContinue
  Write-Host "account $UserName created ($sid)"

  # The user rights NLA actually checks. A network logon is what NLA performs first.
  $secpol = Join-Path $env:TEMP 'secpol.inf'
  & secedit /export /areas USER_RIGHTS /cfg $secpol | Out-Null
  foreach ($right in 'SeNetworkLogonRight', 'SeDenyNetworkLogonRight', 'SeRemoteInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight') {
    $line = (Get-Content $secpol | Where-Object { $_ -match "^$right\s*=" })
    Write-Host "  $right = $(if ($line) { ($line -split '=',2)[1].Trim() } else { '<not set>' })"
  }
  Remove-Item $secpol -ErrorAction SilentlyContinue

  Set-ItemProperty $tsKey -Name fDenyTSConnections -Value 0
  if ((Get-Service TermService).StartType -eq 'Disabled') { Set-Service TermService -StartupType Manual }
  if (-not $origRunning) { Start-Service TermService -ErrorAction SilentlyContinue; $startedByUs = $true }

  $deadline = (Get-Date).AddSeconds(40); $listening = $false
  while ((Get-Date) -lt $deadline -and -not $listening) {
    try { $c = New-Object Net.Sockets.TcpClient
          $iar = $c.BeginConnect('127.0.0.1', 3389, $null, $null)
          if ($iar.AsyncWaitHandle.WaitOne(1000) -and $c.Connected) { $listening = $true }
          $c.Close() } catch {}
    if (-not $listening) { Start-Sleep -Milliseconds 500 }
  }
  Write-Host "listener accepting on 3389: $listening"

  $rdpFile = Join-Path $shareDir 'loopback.rdp'
  Set-Content -Path $rdpFile -Encoding ASCII -Value @"
full address:s:localhost
username:s:$env:COMPUTERNAME\$UserName
authentication level:i:0
prompt for credentials:i:0
screen mode id:i:1
desktopwidth:i:1280
desktopheight:i:720
redirectclipboard:i:0
audiomode:i:0
"@
  $ErrorActionPreference = 'Continue'
  & cmdkey /generic:TERMSRV/localhost /user:"$env:COMPUTERNAME\$UserName" /pass:$plain | Out-Null
  Write-Host "saved credential: $((cmdkey /list | Select-String 'TERMSRV') -join '; ')"
  $ErrorActionPreference = 'Stop'

  Write-Host "`nlaunching mstsc with the owner console still ACTIVE - nothing will be clicked"
  Start-Process mstsc -ArgumentList "`"$rdpFile`"" | Out-Null

  foreach ($t in 6, 14, 25) {
    Start-Sleep -Seconds $(if ($t -eq 6) { 6 } else { 8 })
    $s = @([Iso]::Sessions() | Where-Object { $_.User -eq $UserName })
    Write-Host "`nt=${t}s  renter sessions: $($s.Count) $(if ($s.Count) { "-> id $($s[0].Id) $($s[0].State)" })"
    Shoot -Tag "t$t"
  }

  Write-Host "`n--- all sessions ---"
  [Iso]::Sessions() | Format-Table Id, Station, State, User, IsConsole -AutoSize | Out-String | Write-Host

  Write-Host "--- TS events since start ---"
  foreach ($lg in 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational',
                  'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational') {
    try {
      Get-WinEvent -LogName $lg -MaxEvents 8 -ErrorAction Stop |
        ForEach-Object { Write-Host ("  [{0}] id={1} {2}" -f $_.TimeCreated.ToString('HH:mm:ss'), $_.Id, (($_.Message -split "`r?`n")[0])) }
    } catch { Write-Host "  ($lg unavailable)" }
  }
  Write-Host "--- Security 4625 (failed logon) in the last 5 min ---"
  try {
    Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction Stop |
      ForEach-Object { Write-Host ("  {0}: {1}" -f $_.TimeCreated.ToString('HH:mm:ss'), (($_.Message -split "`r?`n" | Where-Object { $_ -match 'Account Name|Failure Reason|Status|Logon Type' }) -join ' | ')) }
  } catch { Write-Host '  none' }
}
finally {
  $ErrorActionPreference = 'Continue'
  Get-Process mstsc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  & cmdkey /delete:TERMSRV/localhost 2>&1 | Out-Null
  try { Set-ItemProperty $tsKey -Name fDenyTSConnections -Value $origDeny } catch {}
  # Stop the service only if this run started it, and restore its original start type.
  try { if ($startedByUs) { Stop-Service TermService -Force -ErrorAction SilentlyContinue } } catch {}
  try { if ((Get-Service TermService).StartType -ne $origStartType) { Set-Service TermService -StartupType $origStartType } } catch {}
  if ($sid) {
    for ($t = 1; $t -le 6; $t++) {
      $p = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
      if (-not $p) { break }
      try { Remove-CimInstance -InputObject $p -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
    }
  }
  Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $shareDir -ErrorAction SilentlyContinue
  Get-ChildItem $outDir -Filter 'ignore-*.png' -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host "`nrestored: fDenyTSConnections=$((Get-ItemProperty $tsKey -Name fDenyTSConnections).fDenyTSConnections); account present=$([bool](Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue))"
}
