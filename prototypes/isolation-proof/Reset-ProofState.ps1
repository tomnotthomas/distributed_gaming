# Puts the machine back to its pre-proof baseline. Run this if a proof script was interrupted
# and left something behind - notably RDP enabled or the throwaway account still present.
# Safe to run any time; every step is a no-op when there is nothing to undo.
# Must run elevated.

$ErrorActionPreference = 'Continue'

$tsKey = 'HKLM:\System\CurrentControlSet\Control\Terminal Server'
$accounts = @('swiff-iso-proof', 'swiff-switch-proof', 'swiff-session-proof')
$tasks    = @('swiff-proof-tscon', 'swiff-proof-restore-owner', 'swiff-proof-capture')
$shares   = @('swiff-iso-proof', 'swiff-switch-proof', 'swiff-session-proof')

Write-Host '--- resetting proof state ---'

# RDP back off
$deny = (Get-ItemProperty $tsKey -Name fDenyTSConnections -ErrorAction SilentlyContinue).fDenyTSConnections
if ($deny -ne 1) {
  Set-ItemProperty $tsKey -Name fDenyTSConnections -Value 1
  Write-Host "fDenyTSConnections $deny -> 1 (RDP disabled)"
} else { Write-Host 'fDenyTSConnections already 1' }
if ((Get-Service TermService).Status -eq 'Running') {
  Stop-Service TermService -Force -ErrorAction SilentlyContinue
  Write-Host "TermService stopped: $((Get-Service TermService).Status)"
}

# saved credential
& cmdkey /delete:TERMSRV/localhost 2>&1 | Out-Null

# scheduled tasks
foreach ($t in $tasks) { & schtasks /delete /tn $t /f 2>&1 | Out-Null }

# startup item
Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\swiff-proof-capture.cmd') `
  -Force -ErrorAction SilentlyContinue

# share dirs
foreach ($s in $shares) { Remove-Item -Recurse -Force (Join-Path $env:PUBLIC $s) -ErrorAction SilentlyContinue }

# accounts and their profiles
foreach ($a in $accounts) {
  $u = Get-LocalUser -Name $a -ErrorAction SilentlyContinue
  if (-not $u) { continue }
  $sid = $u.SID.Value
  Get-CimInstance Win32_Process | ForEach-Object {
    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
    if ($o -and $o.User -eq $a) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  for ($t = 1; $t -le 8; $t++) {
    $p = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
    if (-not $p) { break }
    try { Remove-CimInstance -InputObject $p -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
  }
  Remove-LocalUser -Name $a -ErrorAction SilentlyContinue
  Write-Host "removed account $a"
}

Write-Host "`n--- state now ---"
Write-Host "fDenyTSConnections : $((Get-ItemProperty $tsKey -Name fDenyTSConnections).fDenyTSConnections)"
Write-Host "TermService        : $((Get-Service TermService).Status) / $((Get-Service TermService).StartType)"
Write-Host "proof accounts     : $(($accounts | Where-Object { Get-LocalUser -Name $_ -ErrorAction SilentlyContinue }) -join ', ')"
Write-Host "C:\Users           : $(((Get-ChildItem C:\Users -Directory).Name) -join ', ')"
Write-Host "saved TERMSRV cred : $(if ((cmdkey /list | Select-String 'TERMSRV')) { 'PRESENT' } else { 'none' })"
Write-Host "startup item       : $(Test-Path (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp\swiff-proof-capture.cmd'))"
