# 寮圭獥鏈熼棿楂橀閲囨牱锛氱粺璁°€屽脊绐楃洊浣忔瀹犮€嶇殑杩炵画鏈€闀挎椂闀匡紙鍒ゆ柇闂儊鏄惁琚帇鍒颁竴甯х骇锛?$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class ZF {
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

$end = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $end) {
  if ((Get-St).breakActive) { break }
  Start-Sleep -Milliseconds 300
}

$h = [RwWin]::FindByTitle('dsh-pet')
$r = [RwWin]::RectOf($h)
$b = [RwWin]::BodyBox($h)
if ($null -ne $b) {
  $cx = $r[0] + ($b[0] + $b[2]) / 2.0
  $bottom = $r[1] + $b[3]
  Write-Output ("pet body: centerX={0} bottom={1} (screen {2}x{3})" -f $cx, $bottom, [RwWin]::ScreenW(), [RwWin]::ScreenH())
}

Write-Output "sampling 120 x 25ms..."
$prev = ''
$hiddenMs = 0
$maxHidden = 0
$t0 = Get-Date
for ($i = 0; $i -lt 480; $i++) {
  [void][RwWin]::Scan([uint32]88944, 800000)
  [ZF]::Scan([RwWin]::PopupHwnd)
  $covered = ($ZF::Pet -gt $ZF::Pop) -and ($ZF::Pop -ge 0)
  if ($covered) { $hiddenMs = $hiddenMs + 25; if ($hiddenMs -gt $maxHidden) { $maxHidden = $hiddenMs } }
  else { $hiddenMs = 0 }
  Start-Sleep -Milliseconds 25
}
$total = [int]((Get-Date) - $t0).TotalMilliseconds
Write-Output ("window={0}ms, max continuous covered = {1}ms" -f $total, $maxHidden)

