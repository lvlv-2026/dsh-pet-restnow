# 抓歇会儿主面板（TkTopLevel 495x849）画面，用来定位「立即休息」按钮
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class PanelCap {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Best; public static int BW, BH, BL, BT;
  public static void Find(uint target) {
    Best = IntPtr.Zero; BW = 0; BH = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target || !IsWindowVisible(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() != "TkTopLevel") return true;
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w * ht > BW * BH && w * ht < 600 * 900) { BW = w; BH = ht; BL = r.Left; BT = r.Top; Best = h; }
      return true;
    }, IntPtr.Zero);
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static bool Cap(IntPtr h, IntPtr hdc) { return PrintWindow(h, hdc, 2); }
}
'@ -ErrorAction SilentlyContinue

[PanelCap]::Find([uint32]88944)
$h = [PanelCap]::Best
"panel hwnd=$h size=$([PanelCap]::BW)x$([PanelCap]::BH) at $([PanelCap]::BL),$([PanelCap]::BT)"
if ($h -eq [IntPtr]::Zero) { exit 1 }
$bmp = New-Object System.Drawing.Bitmap([PanelCap]::BW, [PanelCap]::BH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PanelCap]::Cap($h, $hdc)
$g.ReleaseHdc($hdc); $g.Dispose()
$out = 'D:\Deepseek\dsh-pet-restnow\scripts\_panel.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"captured=$ok -> $out"
