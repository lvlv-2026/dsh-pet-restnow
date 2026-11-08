# 让「新观察器」完整跑一轮：清掉当前弹窗 → 等下一次弹窗 → 量本体落点 → 采样被遮挡时长
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\scripts\TkClicker.cs'
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class ZR {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static int Pet = -1; public static int Pop = -1;
  public static void Scan(IntPtr popup) {
    Pet = -1; Pop = -1; int i = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (h == popup && Pop < 0) Pop = i;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (Pet < 0 && t.ToString().IndexOf("dsh-pet", StringComparison.OrdinalIgnoreCase) >= 0) Pet = i;
      i++; return true;
    }, IntPtr.Zero);
  }
}
'@ -ErrorAction SilentlyContinue

function Get-St { Invoke-RestMethod -Uri 'http://127.0.0.1:47110/status' -TimeoutSec 5 }
function Get-PetBody {
  $h = [RwWin]::FindByTitle('dsh-pet')
  if ($h -eq [IntPtr]::Zero) { return 'none' }
  $r = [RwWin]::RectOf($h)
  $b = [RwWin]::BodyBox($h)
  if ($null -eq $b) { return 'no-body' }
  $cx = $r[0] + ($b[0] + $b[2]) / 2.0
  $bottom = $r[1] + $b[3]
  return "centerX=$cx bottom=$bottom"
}

if ((Get-St).breakActive) {
  Start-Sleep -Seconds 34
  [TkClicker]::Scan([uint32]88944)
  [void][TkClicker]::RealClickCenter()
  $e = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $e) {
    if (-not (Get-St).breakActive) { break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output ("{0} cleared popup, breakActive={1}" -f (Get-Date -Format 'HH:mm:ss'), (Get-St).breakActive)
}

$e2 = (Get-Date).AddSeconds(150)
$opened = $false
while ((Get-Date) -lt $e2) {
  if ((Get-St).breakActive) { $opened = $true; break }
  Start-Sleep -Milliseconds 300
}
Write-Output ("{0} popup opened={1}" -f (Get-Date -Format 'HH:mm:ss'), $opened)
if (-not $opened) { exit 0 }

Start-Sleep -Seconds 2
Write-Output ("body: {0}   (screen center {1})" -f (Get-PetBody), ([RwWin]::ScreenW() / 2))

$hidden = 0
$maxHidden = 0
$t0 = Get-Date
for ($i = 0; $i -lt 280; $i++) {
  [void][RwWin]::Scan([uint32]88944, 800000)
  [ZR]::Scan([RwWin]::PopupHwnd)
  $covered = ([ZR]::Pop -ge 0) -and ([ZR]::Pet -gt [ZR]::Pop)
  if ($covered) { $hidden += 25; if ($hidden -gt $maxHidden) { $maxHidden = $hidden } } else { $hidden = 0 }
  Start-Sleep -Milliseconds 25
}
Write-Output ("sampled {0}ms, max continuous covered = {1}ms" -f [int]((Get-Date) - $t0).TotalMilliseconds, $maxHidden)
