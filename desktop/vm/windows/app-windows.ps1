# The VM test's look at Swiff Host's windows, run inside the logged-on user's
# session (a scheduled task with /it): an SSH session cannot see that desktop.
# Writes one line per visible top-level window of a Swiff Host process -
# "<pid>`t<title>" - to C:\swiff\windows.txt, and the count of the app's main
# processes (Electron's without --type=) on the first line.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SwiffWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static List<string> Visible() {
    var found = new List<string>();
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd)) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      var text = new StringBuilder(512); GetWindowText(hwnd, text, 512);
      found.Add(pid + "\t" + text);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$app = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*Swiff Host*.exe' })
$pids = @($app | ForEach-Object { [string]$_.ProcessId })
$mains = @($app | Where-Object { $_.CommandLine -notmatch '--type=' }).Count
$lines = @("mains`t$mains") + @([SwiffWindows]::Visible() | Where-Object { $pids -contains ($_ -split "`t")[0] })
Set-Content C:\swiff\windows.txt $lines
