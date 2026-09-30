# Watchdog. Runs detached alongside Prove-SwitchDesktop.ps1 and switches the display back to
# the owner's desktop after -AfterSeconds, whatever happened to the main script. Without this,
# a crash between SwitchDesktop and the switch back would strand the screen on an empty desktop.
param([int]$AfterSeconds = 30)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition (Get-Content (Join-Path $root 'Win32Iso.cs') -Raw) -ReferencedAssemblies 'System.Drawing'

Start-Sleep -Seconds $AfterSeconds
try {
  [Iso]::SwitchToByName('Default')
  "watchdog: forced switch back to Default"
} catch {
  "watchdog: $($_.Exception.Message)"
}
