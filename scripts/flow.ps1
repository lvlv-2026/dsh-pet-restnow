# 一次完整的真实流程：关掉当前弹窗 → 等下一次弹窗 → 记录移动后的位置 → 关掉 → 记录复位后的位置
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\scripts\TkClicker.cs'

function Get-St { Invoke-RestMethod -Uri 'http://127.0.0.1:47110/status' -TimeoutSec 5 }
function Get-PetRect {
  $h = [RwWin]::FindByTitle('dsh-pet')
  if ($h -eq [IntPtr]::Zero) { return 'none' }
  $r = [RwWin]::RectOf($h)
  return ($r -join ',')
}
function Invoke-PopupClick {
  [TkClicker]::Scan([uint32]88944)
  if ([TkClicker]::Best -eq [IntPtr]::Zero) { return $false }
  return [TkClicker]::RealClickCenter()
}
function Wait-BreakState([bool]$want, [int]$timeoutSec) {
  $end = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $end) {
    $s = Get-St
    if ($s.breakActive -eq $want) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$now = Get-Date -Format 'HH:mm:ss'
$s0 = Get-St
$r0 = Get-PetRect
Write-Output ("$now start   rect=$r0 breakActive=$($s0.breakActive)")

if ($s0.breakActive) {
  [void](Invoke-PopupClick)
  $closed = Wait-BreakState $false 20
  $now = Get-Date -Format 'HH:mm:ss'
  Write-Output ("$now closed current popup=$closed  rect=$(Get-PetRect)")
}

$opened = Wait-BreakState $true 130
$now = Get-Date -Format 'HH:mm:ss'
Write-Output ("$now next popup opened=$opened  rect(immediately)=$(Get-PetRect)")
if (-not $opened) { exit 0 }

Start-Sleep -Seconds 3
$movedRect = Get-PetRect
$now = Get-Date -Format 'HH:mm:ss'
Write-Output ("$now rect after move = $movedRect")

$h = [RwWin]::FindByTitle('dsh-pet')
$box = [RwWin]::ContentBox($h)
$r = [RwWin]::RectOf($h)
if (($null -ne $box) -and ($null -ne $r)) {
  $l = $r[0] + $box[0]
  $rr = $r[0] + $box[2]
  $t = $r[1] + $box[1]
  $b = $r[1] + $box[3]
  $sw = [RwWin]::ScreenW()
  $sh = [RwWin]::ScreenH()
  Write-Output ("content on screen: x[$l..$rr] y[$t..$b]  (screen ${sw}x${sh})")
}

[void](Invoke-PopupClick)
$closed2 = Wait-BreakState $false 20
Start-Sleep -Milliseconds 900
$now = Get-Date -Format 'HH:mm:ss'
Write-Output ("$now closed=$closed2  rect after restore = $(Get-PetRect)")
