# 以 10ms 采样，统计弹窗盖住桌宠的时长分布（判断降级策略下还有没有可感知的闪烁）
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing

function Get-St { Invoke-RestMethod -Uri 'http://127.0.0.1:47110/status' -TimeoutSec 5 }

$end = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $end) {
  if ((Get-St).breakActive) { break }
  Start-Sleep -Milliseconds 200
}

$pet = [RwWin]::FindByTitle('dsh-pet')
[void][RwWin]::Scan([uint32]88944, 800000)
$popup = [RwWin]::PopupHwnd
"pet=$pet popup=$popup"

$covered = 0
$maxCovered = 0
$events = 0
$t0 = Get-Date
for ($i = 0; $i -lt 600; $i++) {
  $above = [RwWin]::IsAbove($pet, $popup)
  if (-not $above) {
    if ($covered -eq 0) { $events++ }
    $covered = $covered + 10
    if ($covered -gt $maxCovered) { $maxCovered = $covered }
  } else {
    $covered = 0
  }
  Start-Sleep -Milliseconds 10
}
$elapsed = [int]((Get-Date) - $t0).TotalMilliseconds
"elapsed={0}ms dim-events={1} max-dim={2}ms" -f $elapsed, $events, $maxCovered
