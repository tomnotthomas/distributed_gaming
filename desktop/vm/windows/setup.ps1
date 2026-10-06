# The Windows VM's first logon (autounattend.xml): makes it a PC the
# rental-mode installer can be tested on, then powers it off. For a throwaway
# VM only.
#
#   - administrators elevate without a UAC prompt, so the app's one
#     Start-Process -Verb RunAs runs unattended (the prompt itself is
#     Windows'; what is tested is everything after it)
#   - OpenSSH, with the test's key, and Node.js on PATH: how the test drives it
#   - no sleep, no Windows Update restarts
#
# BitLocker comes after, on a boot without the install discs, which it refuses
# to start beside (windows-install-test.sh prepare).
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Transcript -Path C:\swiff-setup.log

Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name ConsentPromptBehaviorAdmin -Value 0

Expand-Archive "$src\node.zip" -DestinationPath C:\
Rename-Item (Get-Item C:\node-v*-win-x64).FullName C:\node
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';C:\node', 'Machine')

Expand-Archive "$src\openssh.zip" -DestinationPath 'C:\Program Files'
& 'C:\Program Files\OpenSSH-Win64\install-sshd.ps1'
New-Item -ItemType Directory -Force C:\ProgramData\ssh | Out-Null
Copy-Item "$src\authorized_keys" C:\ProgramData\ssh\administrators_authorized_keys
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
New-Item -Force HKLM:\SOFTWARE\OpenSSH | Out-Null
New-ItemProperty -Force HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH (Swiff VM test)' -Protocol TCP -LocalPort 22 -Action Allow | Out-Null

powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
Set-Service wuauserv -StartupType Disabled
Stop-Service wuauserv -Force

'done' | Set-Content C:\swiff-setup-done.txt
Stop-Transcript
Stop-Computer -Force
