# 两级验证：① PostMessage 投递点击（不移动光标）是否能让 Tk 弹窗关闭；② 不行则用 SendInput/SetCursorPos 真实点击。
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\scripts\TkClicker.cs'

function Get-Status { Invoke-RestMethod -Uri 'http://127.0.0.1:47110/status' -TimeoutSec 5 }

$deadline = (Get-Date).AddSeconds(150)
$seen = $false
while ((Get-Date) -lt $deadline) {
  $s = Get-Status
  if ($s.breakActive) { $seen = $true; break }
  Start-Sleep -Milliseconds 800
}
if (-not $seen) { Write-Output 'no break popup within 150s'; exit 0 }

[TkClicker]::Scan([uint32]88944)
Write-Output ("popup at {0}: hwnd={1} rect={2},{3} {4}x{5}" -f (Get-Date -Format 'HH:mm:ss'), [TkClicker]::Best, [TkClicker]::BestL, [TkClicker]::BestT, [TkClicker]::BestW, [TkClicker]::BestH)

# ① PostMessage
$okPost = [TkClicker]::ClickCenter()
Start-Sleep -Seconds 4
$s = Get-Status
if (-not $s.breakActive) {
  Write-Output ("RESULT: PostMessage click closed the popup (ok={0})" -f $okPost)
  exit 0
}
Write-Output "PostMessage click: popup still active -> falling back to real input"

# ② 真实输入
$okReal = [TkClicker]::RealClickCenter()
$t0 = Get-Date
$closed = $false
while (((Get-Date) - $t0).TotalSeconds -lt 12) {
  Start-Sleep -Milliseconds 600
  $s = Get-Status
  if (-not $s.breakActive) { $closed = $true; break }
}
if ($closed) {
  $el = [int]((Get-Date) - $t0).TotalSeconds
  Write-Output ("RESULT: real input click closed the popup in {0}s (ok={1}, ends={2}, plays={3})" -f $el, $okReal, $s.stats.breakEnds, $s.pet.plays)
} else {
  Write-Output ("RESULT: neither method closed the popup (real={0})" -f $okReal)
}
