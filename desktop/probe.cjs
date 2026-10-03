// What only Windows itself can say about this PC, asked once per launch in one
// PowerShell run: the graphics card and its memory (DXGI), the hardware video
// encoders its driver brings (NVENC, AMF or QSV, found as Media Foundation
// hardware encoders), the memory sticks and processor cores (WMI), and whether
// the ViGEmBus driver a virtual gamepad needs is installed. The fields and
// their sources are the host report's (docs/system-design/host.md).
//
// The script goes in as -EncodedCommand: nothing is written to disk, and the
// app's files may sit inside an asar archive PowerShell cannot read. Every
// part is best effort: one that cannot be read comes back null.

const { execFile } = require("node:child_process");
const path = require("node:path");

/** Codecs in the report's order, with the Media Foundation subtype each is encoded to. */
const CODECS = {
  h264: "34363248-0000-0010-8000-00AA00389B71",
  hevc: "43564548-0000-0010-8000-00AA00389B71",
  av1: "31305641-0000-0010-8000-00AA00389B71",
};

/** How long the probe may take: compiling the DXGI and Media Foundation calls is most of it. */
const PROBE_TIMEOUT_MS = 30_000;

// DXGI: CreateDXGIFactory1, then IDXGIFactory1::EnumAdapters1 (vtable slot 12)
// and IDXGIAdapter1::GetDesc1 (slot 10), skipping the software adapter (flag 2).
// Media Foundation: MFTEnumEx over hardware video encoders (flag 0x4, sorted
// and filtered 0x40) for each codec's output type.
const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$out = [ordered]@{}
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SwiffProbe {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapters1(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc1(IntPtr self, out Desc1 desc);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Desc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  static T Slot<T>(IntPtr com, int slot) {
    IntPtr vtable = Marshal.ReadIntPtr(com);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, slot * IntPtr.Size), typeof(T));
  }
  public static List<object[]> Adapters() {
    var found = new List<object[]>();
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    if (CreateDXGIFactory1(ref iid, out factory) != 0) return found;
    try {
      for (uint i = 0; i < 16; i++) {
        IntPtr adapter;
        if (Slot<EnumAdapters1>(factory, 12)(factory, i, out adapter) != 0) break;
        try {
          Desc1 d;
          if (Slot<GetDesc1>(adapter, 10)(adapter, out d) == 0 && (d.Flags & 2) == 0)
            found.Add(new object[] { d.Description, (ulong)d.DedicatedVideoMemory });
        } finally { Marshal.Release(adapter); }
      }
    } finally { Marshal.Release(factory); }
    return found;
  }
  [StructLayout(LayoutKind.Sequential)] struct TypeInfo { public Guid Major; public Guid Sub; }
  [DllImport("mfplat.dll")] static extern int MFStartup(uint version, uint flags);
  [DllImport("mfplat.dll")] static extern int MFShutdown();
  [DllImport("mfplat.dll")] static extern int MFTEnumEx(Guid category, uint flags, IntPtr input, ref TypeInfo output, out IntPtr activates, out uint count);
  public static int Encoders(string subtype) {
    var output = new TypeInfo { Major = new Guid("73646976-0000-0010-8000-00AA00389B71"), Sub = new Guid(subtype) };
    IntPtr list; uint count;
    if (MFTEnumEx(new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a"), 0x44, IntPtr.Zero, ref output, out list, out count) != 0) return 0;
    for (int i = 0; i < count; i++) Marshal.Release(Marshal.ReadIntPtr(list, i * IntPtr.Size));
    Marshal.FreeCoTaskMem(list);
    return (int)count;
  }
  public static void Start() { MFStartup(0x20070, 0); }
  public static void Stop() { MFShutdown(); }
}
'@
  $out.adapters = @([SwiffProbe]::Adapters() | ForEach-Object { @{ name = $_[0]; vram = $_[1] } })
  [SwiffProbe]::Start()
  $out.encoders = [ordered]@{
${Object.entries(CODECS)
  .map(([codec, subtype]) => `    ${codec} = [SwiffProbe]::Encoders('${subtype}')`)
  .join("\n")}
  }
  [SwiffProbe]::Stop()
} catch {}
try { $out.ram = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [double]$_.Capacity }) } catch {}
try { $out.cpus = @(Get-CimInstance Win32_Processor | ForEach-Object { @{ name = $_.Name; cores = $_.NumberOfCores } }) } catch {}
$out.vigem = Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\ViGEmBus'
$out | ConvertTo-Json -Compress -Depth 4
`;

/** PowerShell's -EncodedCommand form of `script`: UTF-16LE, base64. */
const encodeCommand = (script) => Buffer.from(script, "utf16le").toString("base64");

/** Whole megabytes: 17,179,869,184 bytes → 16384. */
const wholeMb = (bytes) => (Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 ** 2) : null);

/** A positive whole number, or null. */
const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * What the probe printed, as the report's fields: the card with the most
 * memory of its own (the one games run on, on a laptop with two), memory and
 * cores summed over every stick and socket, the codecs with a hardware
 * encoder, and the gamepad driver. Anything unread is null.
 */
function parseProbe(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("{"));
  let raw;
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const list = (value) => (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []);

  const adapters = list(raw.adapters).filter((a) => typeof a?.name === "string" && a.name.trim());
  const card = adapters.reduce(
    (best, a) => ((Number(a.vram) || 0) > (Number(best?.vram) || 0) ? a : best),
    adapters[0],
  );
  const ram = list(raw.ram).map(Number);
  const cpus = list(raw.cpus);
  const cores = cpus.reduce((sum, c) => sum + (count(c?.cores) ?? 0), 0);
  const encoders = raw.encoders && typeof raw.encoders === "object" ? raw.encoders : null;

  return {
    gpu: card ? card.name.trim() : null,
    vramMb: card ? Math.round((Number(card.vram) || 0) / 1024 ** 2) : null,
    ramMb: ram.length && ram.every(Number.isFinite) ? wholeMb(ram.reduce((a, b) => a + b, 0)) : null,
    cpu: typeof cpus[0]?.name === "string" && cpus[0].name.trim() ? cpus[0].name.trim() : null,
    cores: cores || null,
    encoders: encoders ? Object.keys(CODECS).filter((codec) => Number(encoders[codec]) > 0) : null,
    pad: raw.vigem === true,
  };
}

/** Windows PowerShell 5.1, which every Windows 10 and 11 has. */
const powershell = (env) =>
  path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The probe's reading of this PC; null anywhere but Windows, or when PowerShell cannot run it. */
function readWindowsProbe({ platform = process.platform, env = process.env, run = execFile } = {}) {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    run(
      powershell(env),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(PROBE_SCRIPT)],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseProbe(stdout)),
    );
  });
}

module.exports = { CODECS, PROBE_SCRIPT, encodeCommand, parseProbe, readWindowsProbe };
