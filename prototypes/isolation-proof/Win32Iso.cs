using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class Iso {
  // ---------- constants ----------
  const uint DACL_SECURITY_INFORMATION = 4;
  const int WINSTA_ALL  = 0xF037F;
  const int DESKTOP_ALL = 0xF01FF;
  const int GENERIC_ALL = 0x10000000;

  // ---------- window station / desktop ----------
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string desktop, string device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SwitchDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool GetUserObjectInformationW(IntPtr h, int index, byte[] info, uint len, out uint needed);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetUserObjectSecurity(IntPtr h, ref uint si, byte[] sd, uint len, out uint needed);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetUserObjectSecurity(IntPtr h, ref uint si, byte[] sd);

  delegate bool EnumDesktopWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateDCW(string driver, string device, string output, IntPtr dm);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int dx, int dy, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

  // ---------- launching a process as another user, on a chosen desktop ----------
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithLogonW(
    string user, string domain, string password, uint logonFlags,
    string appName, StringBuilder cmdLine, uint creationFlags, IntPtr env, string cwd,
    ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  const uint LOGON_WITH_PROFILE = 0x1;
  const uint CREATE_NEW_CONSOLE = 0x10;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;

  // ---------- public API ----------
  public static IntPtr MakeDesktop(string name) {
    IntPtr h = CreateDesktop(name, null, IntPtr.Zero, 0, (uint)GENERIC_ALL, IntPtr.Zero);
    if (h == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
    return h;
  }

  public static void KillDesktop(IntPtr h) { CloseDesktop(h); }

  public static IntPtr OpenDesktopByName(string name) {
    IntPtr h = OpenDesktopW(name, 0, false, (uint)GENERIC_ALL);
    if (h == IntPtr.Zero) throw new Exception("OpenDesktop(" + name + ") failed: " + Marshal.GetLastWin32Error());
    return h;
  }

  /// Makes hDesk the one the monitor shows and the keyboard/mouse talk to.
  public static void Switch(IntPtr hDesk) {
    if (!SwitchDesktop(hDesk)) throw new Exception("SwitchDesktop failed: " + Marshal.GetLastWin32Error());
  }

  public static void SwitchToByName(string name) {
    IntPtr h = OpenDesktopByName(name);
    try { Switch(h); } finally { CloseDesktop(h); }
  }

  /// The window station this process is attached to. Sessions get their own; a second desktop
  /// inside one session does not - which is why a secondary desktop shares the owner's clipboard.
  public static string ProcessWindowStationName() {
    IntPtr h = GetProcessWindowStation();
    if (h == IntPtr.Zero) return "<none>";
    byte[] buf = new byte[512];
    uint needed;
    if (!GetUserObjectInformationW(h, 2 /* UOI_NAME */, buf, (uint)buf.Length, out needed))
      return "<query failed: " + Marshal.GetLastWin32Error() + ">";
    return Encoding.Unicode.GetString(buf, 0, (int)Math.Max(0, needed - 2));
  }

  // ---------------- terminal-services session enumeration ----------------
  [StructLayout(LayoutKind.Sequential)]
  struct WTS_SESSION_INFO { public uint SessionId; public IntPtr pWinStationName; public int State; }

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);
  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out uint bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();

  public class Sess {
    public uint Id; public string Station; public string State; public string User; public string Domain;
    public bool IsConsole;
  }

  static string StateName(int s) {
    switch (s) {
      case 0: return "Active"; case 1: return "Connected"; case 2: return "ConnectQuery";
      case 3: return "Shadow"; case 4: return "Disconnected"; case 5: return "Idle";
      case 6: return "Listen"; case 7: return "Reset"; case 8: return "Down"; case 9: return "Init";
      default: return "?" + s;
    }
  }

  static string QueryStr(uint sessionId, int infoClass) {
    IntPtr buf; uint bytes;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, sessionId, infoClass, out buf, out bytes)) return "";
    try { return Marshal.PtrToStringUni(buf) ?? ""; } finally { WTSFreeMemory(buf); }
  }

  public static List<Sess> Sessions() {
    List<Sess> list = new List<Sess>();
    IntPtr info; int count;
    if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out info, out count))
      throw new Exception("WTSEnumerateSessions failed: " + Marshal.GetLastWin32Error());
    uint console = WTSGetActiveConsoleSessionId();
    try {
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      for (int i = 0; i < count; i++) {
        WTS_SESSION_INFO si = (WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(info, i * size), typeof(WTS_SESSION_INFO));
        Sess s = new Sess();
        s.Id = si.SessionId;
        s.Station = Marshal.PtrToStringUni(si.pWinStationName) ?? "";
        s.State = StateName(si.State);
        s.User = QueryStr(si.SessionId, 5 /* WTSUserName */);
        s.Domain = QueryStr(si.SessionId, 7 /* WTSDomainName */);
        s.IsConsole = (si.SessionId == console);
        list.Add(s);
      }
    } finally { WTSFreeMemory(info); }
    return list;
  }

  public static uint ConsoleSessionId() { return WTSGetActiveConsoleSessionId(); }

  /// Name of the desktop currently receiving input - the independent check that a switch happened.
  public static string InputDesktopName() {
    IntPtr h = OpenInputDesktop(0, false, (uint)GENERIC_ALL);
    if (h == IntPtr.Zero) return "<no access: " + Marshal.GetLastWin32Error() + ">";
    try {
      byte[] buf = new byte[512];
      uint needed;
      if (!GetUserObjectInformationW(h, 2 /* UOI_NAME */, buf, (uint)buf.Length, out needed))
        return "<query failed: " + Marshal.GetLastWin32Error() + ">";
      return Encoding.Unicode.GetString(buf, 0, (int)Math.Max(0, needed - 2));
    } finally { CloseDesktop(h); }
  }

  static void AddAces(IntPtr hObj, string sidStr, bool isWinSta) {
    uint si = DACL_SECURITY_INFORMATION;
    uint needed;
    byte[] buf = new byte[4096];
    if (!GetUserObjectSecurity(hObj, ref si, buf, (uint)buf.Length, out needed)) {
      buf = new byte[needed];
      if (!GetUserObjectSecurity(hObj, ref si, buf, needed, out needed))
        throw new Exception("GetUserObjectSecurity failed: " + Marshal.GetLastWin32Error());
    }
    RawSecurityDescriptor rsd = new RawSecurityDescriptor(buf, 0);
    RawAcl acl = rsd.DiscretionaryAcl;
    if (acl == null) acl = new RawAcl(2, 2);
    SecurityIdentifier sid = new SecurityIdentifier(sidStr);
    if (isWinSta) {
      // An inherit-only ACE so desktops under this window station inherit the grant,
      // plus a direct ACE for the window station object itself.
      acl.InsertAce(0, new CommonAce(
        AceFlags.ObjectInherit | AceFlags.InheritOnly | AceFlags.NoPropagateInherit,
        AceQualifier.AccessAllowed, DESKTOP_ALL, sid, false, null));
      acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, WINSTA_ALL, sid, false, null));
    } else {
      acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, DESKTOP_ALL, sid, false, null));
    }
    rsd.DiscretionaryAcl = acl;
    byte[] outBuf = new byte[rsd.BinaryLength];
    rsd.GetBinaryForm(outBuf, 0);
    if (!SetUserObjectSecurity(hObj, ref si, outBuf))
      throw new Exception("SetUserObjectSecurity failed: " + Marshal.GetLastWin32Error());
  }

  public static void GrantWinSta(string sid) { AddAces(GetProcessWindowStation(), sid, true); }
  public static void GrantDesktop(IntPtr hDesk, string sid) { AddAces(hDesk, sid, false); }

  // Undo the grant, so we do not leave an orphaned SID on the interactive window station.
  // (WinSta0 is recreated at logon, so this is belt-and-braces, not persistence cleanup.)
  public static int RevokeWinSta(string sidStr) {
    IntPtr hObj = GetProcessWindowStation();
    uint si = DACL_SECURITY_INFORMATION;
    uint needed;
    byte[] buf = new byte[4096];
    if (!GetUserObjectSecurity(hObj, ref si, buf, (uint)buf.Length, out needed)) {
      buf = new byte[needed];
      if (!GetUserObjectSecurity(hObj, ref si, buf, needed, out needed))
        throw new Exception("GetUserObjectSecurity failed: " + Marshal.GetLastWin32Error());
    }
    RawSecurityDescriptor rsd = new RawSecurityDescriptor(buf, 0);
    RawAcl acl = rsd.DiscretionaryAcl;
    if (acl == null) return 0;
    SecurityIdentifier sid = new SecurityIdentifier(sidStr);
    int removed = 0;
    for (int i = acl.Count - 1; i >= 0; i--) {
      CommonAce ca = acl[i] as CommonAce;
      if (ca != null && ca.SecurityIdentifier == sid) { acl.RemoveAce(i); removed++; }
    }
    if (removed > 0) {
      rsd.DiscretionaryAcl = acl;
      byte[] outBuf = new byte[rsd.BinaryLength];
      rsd.GetBinaryForm(outBuf, 0);
      if (!SetUserObjectSecurity(hObj, ref si, outBuf))
        throw new Exception("SetUserObjectSecurity failed: " + Marshal.GetLastWin32Error());
    }
    return removed;
  }

  public static int LaunchAs(string user, string password, string cmdLine, string desktop, string cwd) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = desktop;
    PROCESS_INFORMATION pi;
    if (!CreateProcessWithLogonW(user, ".", password, LOGON_WITH_PROFILE,
          null, new StringBuilder(cmdLine), CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
          IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcessWithLogonW failed: " + Marshal.GetLastWin32Error());
    return pi.dwProcessId;
  }

  public class Win {
    public IntPtr Hwnd; public uint Pid; public string Title; public string Class;
    public bool Visible; public int W; public int H;
  }

  public static List<Win> ListWindows(IntPtr hDesk) {
    List<Win> found = new List<Win>();
    EnumDesktopWindows(hDesk, delegate (IntPtr hwnd, IntPtr lp) {
      StringBuilder t = new StringBuilder(512); GetWindowTextW(hwnd, t, 512);
      StringBuilder c = new StringBuilder(256); GetClassNameW(hwnd, c, 256);
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      RECT r; GetWindowRect(hwnd, out r);
      Win w = new Win();
      w.Hwnd = hwnd; w.Pid = pid; w.Title = t.ToString(); w.Class = c.ToString();
      w.Visible = IsWindowVisible(hwnd); w.W = r.R - r.L; w.H = r.B - r.T;
      found.Add(w);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public class Shot { public string Path; public int Colors; public bool Ok; public string Note; }

  // Capture runs on its own thread, switched to hDesk, so it sees that desktop and no other.
  public static Shot[] Capture(IntPtr hDesk, IntPtr targetHwnd, string fullPath, string winPath) {
    Shot[] result = new Shot[2];
    string err = null;
    Thread th = new Thread(delegate () {
      try {
        if (!SetThreadDesktop(hDesk))
          throw new Exception("SetThreadDesktop failed: " + Marshal.GetLastWin32Error());
        result[0] = FullDesktop(fullPath);
        result[1] = OneWindow(targetHwnd, winPath);
      } catch (Exception e) { err = e.ToString(); }
    });
    th.SetApartmentState(ApartmentState.STA);
    th.IsBackground = true;
    th.Start();
    // Bounded. PrintWindow sends WM_PRINT and waits for the target to paint; a window whose owner
    // is blocked - or which lives in a disconnected session - never answers, and an unbounded
    // Join() then wedges the caller for good.
    if (!th.Join(15000)) {
      Shot t = new Shot();
      t.Path = fullPath;
      t.Note = "capture thread timed out after 15s";
      return new Shot[] { t, t };
    }
    if (err != null) throw new Exception(err);
    return result;
  }

  static Shot FullDesktop(string path) {
    Shot s = new Shot(); s.Path = path;
    IntPtr hdc = CreateDCW("DISPLAY", null, null, IntPtr.Zero);
    if (hdc == IntPtr.Zero) { s.Note = "CreateDC(DISPLAY) failed " + Marshal.GetLastWin32Error(); return s; }
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    if (w <= 0 || h <= 0) { w = 1920; h = 1080; }
    IntPtr mem = CreateCompatibleDC(hdc);
    IntPtr bmp = CreateCompatibleBitmap(hdc, w, h);
    IntPtr old = SelectObject(mem, bmp);
    bool ok = BitBlt(mem, 0, 0, w, h, hdc, 0, 0, 0x00CC0020);
    int err = Marshal.GetLastWin32Error();
    SelectObject(mem, old);
    try {
      using (Bitmap b = Image.FromHbitmap(bmp)) {
        b.Save(path, ImageFormat.Png);
        s.Colors = CountColors(b);
      }
      s.Ok = ok;
      s.Note = ok ? (w + "x" + h) : ("BitBlt failed " + err);
    } catch (Exception e) { s.Note = e.Message; }
    DeleteObject(bmp); DeleteDC(mem); DeleteDC(hdc);
    return s;
  }

  static Shot OneWindow(IntPtr hwnd, string path) {
    Shot s = new Shot(); s.Path = path;
    if (hwnd == IntPtr.Zero) { s.Note = "no target window"; return s; }
    RECT r; GetWindowRect(hwnd, out r);
    int w = r.R - r.L, h = r.B - r.T;
    if (w <= 0 || h <= 0) { s.Note = "empty window rect"; return s; }
    using (Bitmap b = new Bitmap(w, h))
    using (Graphics g = Graphics.FromImage(b)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2 /* PW_RENDERFULLCONTENT */);
      g.ReleaseHdc(hdc);
      b.Save(path, ImageFormat.Png);
      s.Colors = CountColors(b);
      s.Ok = ok;
      s.Note = ok ? (w + "x" + h) : "PrintWindow returned false";
    }
    return s;
  }

  static int CountColors(Bitmap b) {
    HashSet<int> set = new HashSet<int>();
    int stepX = Math.Max(1, b.Width / 160), stepY = Math.Max(1, b.Height / 160);
    for (int y = 0; y < b.Height; y += stepY)
      for (int x = 0; x < b.Width; x += stepX) {
        set.Add(b.GetPixel(x, y).ToArgb());
        if (set.Count > 4000) return set.Count;
      }
    return set.Count;
  }
}
