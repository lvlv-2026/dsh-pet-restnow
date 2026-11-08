# 后台监测：等下一次真实弹窗，5ms 采样记录桌宠被弹窗盖住的时长；结果追加到 _dim.log
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing
$log = 'D:\Deepseek\dsh-pet-restnow\scripts\_dim.log'
function W([string]$s) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $s) -Encoding UTF8 }

W 'monitor armed'
$deadline = (Get-Date).AddMinutes(45)
$pet = [IntPtr]::Zero
$popup = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  [void][RwWin]::Scan([uint32]88944, 800000)
  if ([RwWin]::PopupHwnd -ne [IntPtr]::Zero) { $popup = [RwWin]::PopupHwnd; break }
  Start-Sleep -Milliseconds 500
}
if ($popup -eq [IntPtr]::Zero) { W 'no popup within 45min'; exit 0 }

$pet = [RwWin]::FindByTitle('dsh-pet')
W ("popup detected hwnd=$popup pet=$pet")

$covered = 0; $maxC = 0; $events = 0
$t0 = Get-Date
for ($i = 0; $i -lt 2400; $i++) {
  if ([RwWin]::IsAbove($pet, $popup)) { $covered = 0 }
  else {
    if ($covered -eq 0) { $events++ }
    $covered += 5
    if ($covered -gt $maxC) { $maxC = $covered }
  }
  Start-Sleep -Milliseconds 5
}
W ("sampled={0}ms dim-events={1} max-dim={2}ms" -f [int]((Get-Date) - $t0).TotalMilliseconds, $events, $maxC)
