using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

// Minimal DXGI Desktop Duplication interop.
//
// Only the methods actually called are given real signatures; every preceding vtable slot is
// declared as a no-arg placeholder purely to get the COM vtable indices right. Do not call them.
public static class Dda {

  // ---------------- COM interfaces ----------------
  [ComImport, Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIDevice {
    // IDXGIObject
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    // IDXGIDevice
    [PreserveSig] int GetAdapter(out IDXGIAdapter adapter);
  }

  [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter {
    // IDXGIObject
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    // IDXGIAdapter
    [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
    [PreserveSig] int GetDesc(out DXGI_ADAPTER_DESC desc);
  }

  [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIOutput {
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    [PreserveSig] int GetDesc();
    [PreserveSig] int GetDisplayModeList();
    [PreserveSig] int FindClosestMatchingMode();
    [PreserveSig] int WaitForVBlank();
    [PreserveSig] int TakeOwnership();
    [PreserveSig] void ReleaseOwnership();
    [PreserveSig] int GetGammaControlCapabilities();
    [PreserveSig] int SetGammaControl();
    [PreserveSig] int GetGammaControl();
    [PreserveSig] int SetDisplaySurface();
    [PreserveSig] int GetDisplaySurfaceData();
    [PreserveSig] int GetFrameStatistics();
  }

  [ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIOutput1 {
    // IDXGIObject
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    // IDXGIOutput
    [PreserveSig] int GetDesc();
    [PreserveSig] int GetDisplayModeList();
    [PreserveSig] int FindClosestMatchingMode();
    [PreserveSig] int WaitForVBlank();
    [PreserveSig] int TakeOwnership();
    [PreserveSig] void ReleaseOwnership();
    [PreserveSig] int GetGammaControlCapabilities();
    [PreserveSig] int SetGammaControl();
    [PreserveSig] int GetGammaControl();
    [PreserveSig] int SetDisplaySurface();
    [PreserveSig] int GetDisplaySurfaceData();
    [PreserveSig] int GetFrameStatistics();
    // IDXGIOutput1
    [PreserveSig] int GetDisplayModeList1();
    [PreserveSig] int FindClosestMatchingMode1();
    [PreserveSig] int GetDisplaySurfaceData1();
    [PreserveSig] int DuplicateOutput(IntPtr device, out IDXGIOutputDuplication dup);
  }

  [ComImport, Guid("191cfac3-a341-470d-b26e-a864f428319c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIOutputDuplication {
    // IDXGIObject
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    // IDXGIOutputDuplication
    [PreserveSig] void GetDesc(out DXGI_OUTDUPL_DESC desc);
    [PreserveSig] int AcquireNextFrame(uint timeoutMs, out DXGI_OUTDUPL_FRAME_INFO info, out IntPtr desktopResource);
    [PreserveSig] int GetFrameDirtyRects();
    [PreserveSig] int GetFrameMoveRects();
    [PreserveSig] int GetFramePointerShape();
    [PreserveSig] int MapDesktopSurface(out DXGI_MAPPED_RECT lockedRect);
    [PreserveSig] int UnMapDesktopSurface();
    [PreserveSig] int ReleaseFrame();
  }

  // ---------------- structs ----------------
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DXGI_ADAPTER_DESC {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public IntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public long AdapterLuid;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_MODE_DESC {
    public uint Width, Height, RefreshNum, RefreshDen, Format, ScanlineOrdering, Scaling;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_OUTDUPL_DESC {
    public DXGI_MODE_DESC ModeDesc;
    public uint Rotation;
    [MarshalAs(UnmanagedType.Bool)] public bool DesktopImageInSystemMemory;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_OUTDUPL_POINTER_POSITION { public int X, Y; [MarshalAs(UnmanagedType.Bool)] public bool Visible; }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_OUTDUPL_FRAME_INFO {
    public long LastPresentTime, LastMouseUpdateTime;
    public uint AccumulatedFrames;
    [MarshalAs(UnmanagedType.Bool)] public bool RectsCoalesced;
    [MarshalAs(UnmanagedType.Bool)] public bool ProtectedContentMaskedOut;
    public DXGI_OUTDUPL_POINTER_POSITION PointerPosition;
    public uint TotalMetadataBufferSize, PointerShapeBufferSize;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_MAPPED_RECT { public int Pitch; public IntPtr pBits; }

  // ---- the staging-texture readback path, for when MapDesktopSurface is unsupported ----
  [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ID3D11Device {
    [PreserveSig] int CreateBuffer();
    [PreserveSig] int CreateTexture1D();
    [PreserveSig] int CreateTexture2D(ref D3D11_TEXTURE2D_DESC desc, IntPtr initialData, out IntPtr texture);
  }

  [ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ID3D11DeviceContext {
    // ID3D11DeviceChild
    [PreserveSig] void GetDevice();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    // ID3D11DeviceContext
    [PreserveSig] void VSSetConstantBuffers();
    [PreserveSig] void PSSetShaderResources();
    [PreserveSig] void PSSetShader();
    [PreserveSig] void PSSetSamplers();
    [PreserveSig] void VSSetShader();
    [PreserveSig] void DrawIndexed();
    [PreserveSig] void Draw();
    [PreserveSig] int Map(IntPtr resource, uint subresource, uint mapType, uint mapFlags, out D3D11_MAPPED_SUBRESOURCE mapped);
    [PreserveSig] void Unmap(IntPtr resource, uint subresource);
    [PreserveSig] void PSSetConstantBuffers();
    [PreserveSig] void IASetInputLayout();
    [PreserveSig] void IASetVertexBuffers();
    [PreserveSig] void IASetIndexBuffer();
    [PreserveSig] void DrawIndexedInstanced();
    [PreserveSig] void DrawInstanced();
    [PreserveSig] void GSSetConstantBuffers();
    [PreserveSig] void GSSetShader();
    [PreserveSig] void IASetPrimitiveTopology();
    [PreserveSig] void VSSetShaderResources();
    [PreserveSig] void VSSetSamplers();
    [PreserveSig] void Begin();
    [PreserveSig] void End();
    [PreserveSig] int GetData();
    [PreserveSig] void SetPredication();
    [PreserveSig] void GSSetShaderResources();
    [PreserveSig] void GSSetSamplers();
    [PreserveSig] void OMSetRenderTargets();
    [PreserveSig] void OMSetRenderTargetsAndUnorderedAccessViews();
    [PreserveSig] void OMSetBlendState();
    [PreserveSig] void OMSetDepthStencilState();
    [PreserveSig] void SOSetTargets();
    [PreserveSig] void DrawAuto();
    [PreserveSig] void DrawIndexedInstancedIndirect();
    [PreserveSig] void DrawInstancedIndirect();
    [PreserveSig] void Dispatch();
    [PreserveSig] void DispatchIndirect();
    [PreserveSig] void RSSetState();
    [PreserveSig] void RSSetViewports();
    [PreserveSig] void RSSetScissorRects();
    [PreserveSig] void CopySubresourceRegion();
    [PreserveSig] void CopyResource(IntPtr dst, IntPtr src);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DXGI_SAMPLE_DESC { public uint Count, Quality; }

  [StructLayout(LayoutKind.Sequential)]
  struct D3D11_TEXTURE2D_DESC {
    public uint Width, Height, MipLevels, ArraySize, Format;
    public DXGI_SAMPLE_DESC SampleDesc;
    public uint Usage, BindFlags, CPUAccessFlags, MiscFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct D3D11_MAPPED_SUBRESOURCE { public IntPtr pData; public uint RowPitch, DepthPitch; }

  const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;
  const uint D3D11_USAGE_STAGING = 3;
  const uint D3D11_CPU_ACCESS_READ = 0x20000;
  const uint D3D11_MAP_READ = 1;
  static readonly Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

  [DllImport("d3d11.dll")]
  static extern int D3D11CreateDevice(
    IntPtr adapter, int driverType, IntPtr software, uint flags,
    IntPtr featureLevels, uint featureLevelCount, uint sdkVersion,
    [MarshalAs(UnmanagedType.IUnknown)] out object device, out int featureLevel,
    [MarshalAs(UnmanagedType.IUnknown)] out object context);

  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);

  const int DXGI_ERROR_WAIT_TIMEOUT   = unchecked((int)0x887A0027);
  const int DXGI_ERROR_ACCESS_LOST    = unchecked((int)0x887A0026);
  const int DXGI_ERROR_ACCESS_DENIED  = unchecked((int)0x887A002B);
  const int DXGI_ERROR_UNSUPPORTED    = unchecked((int)0x887A0004);
  const int E_ACCESSDENIED            = unchecked((int)0x80070005);

  public static string Hr(int hr) {
    switch (hr) {
      case 0: return "S_OK";
      case DXGI_ERROR_WAIT_TIMEOUT:  return "DXGI_ERROR_WAIT_TIMEOUT";
      case DXGI_ERROR_ACCESS_LOST:   return "DXGI_ERROR_ACCESS_LOST";
      case DXGI_ERROR_ACCESS_DENIED: return "DXGI_ERROR_ACCESS_DENIED";
      case DXGI_ERROR_UNSUPPORTED:   return "DXGI_ERROR_UNSUPPORTED";
      case E_ACCESSDENIED:           return "E_ACCESSDENIED";
      default: return "0x" + hr.ToString("X8");
    }
  }

  public class Result {
    public bool DeviceOk, DuplicateOk;
    public string Adapter = "", Stage = "", Error = "", ReadbackPath = "";
    public int Width, Height;
    public bool ImageInSystemMemory;
    public int FramesAcquired, Timeouts, Colors;
    public double Seconds, Fps;
    public string PngPath = "";
    public bool PngWritten;
  }

  /// Run() on a dedicated thread. SetThreadDesktop refuses to move a thread that already owns
  /// windows or hooks, which the PowerShell host thread does, so always go through this.
  public static Result RunOnThread(IntPtr hDesk, int durationMs, string pngPath) {
    Result[] box = new Result[1];
    Thread th = new Thread(delegate () { box[0] = Run(hDesk, durationMs, pngPath); });
    th.SetApartmentState(ApartmentState.MTA);
    th.Start();
    if (!th.Join(durationMs + 20000)) {
      Result r = new Result();
      r.Error = "capture thread did not finish";
      return r;
    }
    return box[0];
  }

  /// Duplicates the output for `durationMs`, optionally after switching the calling thread
  /// to `hDesk`. Writes the last frame to pngPath.
  public static Result Run(IntPtr hDesk, int durationMs, string pngPath) {
    Result r = new Result();
    r.PngPath = pngPath;
    object deviceObj = null, contextObj = null;
    IDXGIDevice dxgiDev = null;
    IDXGIAdapter adapter = null;
    IDXGIOutput output = null;
    IDXGIOutput1 output1 = null;
    IDXGIOutputDuplication dup = null;
    ID3D11Device dev = null;
    ID3D11DeviceContext ctx = null;
    IntPtr pDevice = IntPtr.Zero, staging = IntPtr.Zero;

    try {
      if (hDesk != IntPtr.Zero) {
        r.Stage = "SetThreadDesktop";
        if (!SetThreadDesktop(hDesk)) {
          r.Error = "SetThreadDesktop failed: " + Marshal.GetLastWin32Error();
          return r;
        }
      }

      r.Stage = "D3D11CreateDevice";
      int fl;
      int hr = D3D11CreateDevice(IntPtr.Zero, 1 /* HARDWARE */, IntPtr.Zero, 0,
                                 IntPtr.Zero, 0, 7 /* D3D11_SDK_VERSION */,
                                 out deviceObj, out fl, out contextObj);
      if (hr != 0) { r.Error = "D3D11CreateDevice " + Hr(hr); return r; }
      r.DeviceOk = true;
      dev = (ID3D11Device)deviceObj;
      ctx = (ID3D11DeviceContext)contextObj;

      r.Stage = "IDXGIDevice::GetAdapter";
      dxgiDev = (IDXGIDevice)deviceObj;
      hr = dxgiDev.GetAdapter(out adapter);
      if (hr != 0) { r.Error = "GetAdapter " + Hr(hr); return r; }

      DXGI_ADAPTER_DESC ad;
      if (adapter.GetDesc(out ad) == 0) r.Adapter = ad.Description;

      r.Stage = "EnumOutputs(0)";
      hr = adapter.EnumOutputs(0, out output);
      if (hr != 0) { r.Error = "EnumOutputs " + Hr(hr); return r; }

      r.Stage = "QueryInterface IDXGIOutput1";
      output1 = (IDXGIOutput1)output;

      r.Stage = "DuplicateOutput";
      pDevice = Marshal.GetIUnknownForObject(deviceObj);
      hr = output1.DuplicateOutput(pDevice, out dup);
      if (hr != 0) { r.Error = "DuplicateOutput " + Hr(hr); return r; }
      r.DuplicateOk = true;

      DXGI_OUTDUPL_DESC dd;
      dup.GetDesc(out dd);
      r.Width = (int)dd.ModeDesc.Width;
      r.Height = (int)dd.ModeDesc.Height;
      r.ImageInSystemMemory = dd.DesktopImageInSystemMemory;

      r.Stage = "AcquireNextFrame loop";
      Stopwatch sw = Stopwatch.StartNew();
      while (sw.ElapsedMilliseconds < durationMs) {
        DXGI_OUTDUPL_FRAME_INFO info;
        IntPtr res;
        hr = dup.AcquireNextFrame(100, out info, out res);
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) { r.Timeouts++; continue; }
        if (hr != 0) { r.Error = "AcquireNextFrame " + Hr(hr); break; }
        r.FramesAcquired++;

        // Read pixels back only on the first and last frames. Doing it every frame would make
        // this a measurement of PNG encoding, not of capture throughput.
        // MapDesktopSurface is the cheap route and works only when the desktop image already
        // lives in system memory; otherwise copy to a staging texture and read that. A real
        // encoder would hand the GPU texture straight to the encoder and never touch the CPU.
        bool wantPixels = (r.FramesAcquired == 1) || (sw.ElapsedMilliseconds >= durationMs - 250);
        if (!wantPixels) { if (res != IntPtr.Zero) Marshal.Release(res); dup.ReleaseFrame(); continue; }

        DXGI_MAPPED_RECT mapped;
        int mhr = dup.MapDesktopSurface(out mapped);
        if (mhr == 0) {
          r.ReadbackPath = "MapDesktopSurface";
          try { SaveBgra(mapped.pBits, mapped.Pitch, r.Width, r.Height, pngPath, r); }
          finally { dup.UnMapDesktopSurface(); }
        } else if (res != IntPtr.Zero) {
          r.ReadbackPath = "staging texture (MapDesktopSurface " + Hr(mhr) + ")";
          IntPtr tex;
          Guid iid = IID_ID3D11Texture2D;
          if (Marshal.QueryInterface(res, ref iid, out tex) == 0) {
            try {
              if (staging == IntPtr.Zero) {
                D3D11_TEXTURE2D_DESC sd = new D3D11_TEXTURE2D_DESC();
                sd.Width = (uint)r.Width; sd.Height = (uint)r.Height;
                sd.MipLevels = 1; sd.ArraySize = 1;
                sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                sd.SampleDesc.Count = 1; sd.SampleDesc.Quality = 0;
                sd.Usage = D3D11_USAGE_STAGING;
                sd.BindFlags = 0; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ; sd.MiscFlags = 0;
                int chr = dev.CreateTexture2D(ref sd, IntPtr.Zero, out staging);
                if (chr != 0) { r.Error = "CreateTexture2D " + Hr(chr); staging = IntPtr.Zero; }
              }
              if (staging != IntPtr.Zero) {
                ctx.CopyResource(staging, tex);
                D3D11_MAPPED_SUBRESOURCE ms;
                int mr2 = ctx.Map(staging, 0, D3D11_MAP_READ, 0, out ms);
                if (mr2 == 0) {
                  try { SaveBgra(ms.pData, (int)ms.RowPitch, r.Width, r.Height, pngPath, r); }
                  finally { ctx.Unmap(staging, 0); }
                } else { r.Error = "Map(staging) " + Hr(mr2); }
              }
            } finally { Marshal.Release(tex); }
          }
        }
        if (res != IntPtr.Zero) Marshal.Release(res);
        dup.ReleaseFrame();
      }
      sw.Stop();
      r.Seconds = sw.Elapsed.TotalSeconds;
      r.Fps = r.Seconds > 0 ? r.FramesAcquired / r.Seconds : 0;
      r.Stage = "done";
      return r;
    } catch (Exception e) {
      r.Error = r.Stage + ": " + e.Message;
      return r;
    } finally {
      if (staging != IntPtr.Zero) Marshal.Release(staging);
      if (dup != null) Marshal.ReleaseComObject(dup);
      if (output1 != null) Marshal.ReleaseComObject(output1);
      if (adapter != null) Marshal.ReleaseComObject(adapter);
      if (dxgiDev != null) Marshal.ReleaseComObject(dxgiDev);
      if (pDevice != IntPtr.Zero) Marshal.Release(pDevice);
      if (contextObj != null) Marshal.ReleaseComObject(contextObj);
      if (deviceObj != null) Marshal.ReleaseComObject(deviceObj);
    }
  }

  static void SaveBgra(IntPtr bits, int pitch, int w, int h, string path, Result r) {
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb)) {
      BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
      try {
        byte[] row = new byte[w * 4];
        for (int y = 0; y < h; y++) {
          Marshal.Copy(IntPtr.Add(bits, y * pitch), row, 0, w * 4);
          Marshal.Copy(row, 0, IntPtr.Add(bd.Scan0, y * bd.Stride), w * 4);
        }
      } finally { bmp.UnlockBits(bd); }
      bmp.Save(path, ImageFormat.Png);
      r.PngWritten = true;
      r.Colors = CountColors(bmp);
    }
  }

  static int CountColors(Bitmap b) {
    System.Collections.Generic.HashSet<int> set = new System.Collections.Generic.HashSet<int>();
    int sx = Math.Max(1, b.Width / 160), sy = Math.Max(1, b.Height / 160);
    for (int y = 0; y < b.Height; y += sy)
      for (int x = 0; x < b.Width; x += sx) {
        set.Add(b.GetPixel(x, y).ToArgb());
        if (set.Count > 4000) return set.Count;
      }
    return set.Count;
  }
}
