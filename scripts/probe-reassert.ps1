# 决定性实验：停掉观察器后手动抬一次桌宠，看弹窗是否会自己把它压回去
$ErrorActionPreference = 'Continue'
Add-Type -Path 'D:\Deepseek\dsh-pet-restnow\assets\RwWin.cs' -ReferencedAssemblies System.Drawing

# 1. 停掉观察器（改文件名，插件重启不了）
$script = 'D:\Deepseek\dsh-pet-restnow\assets\watch-restnow.ps1'
$bak = "$script.bak"
$w = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match '-File .*watch-restnow\.ps1' }
foreach ($x in $w) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
if (Test-Path $script) { Move-Item $script $bak -Force }
Write-Output "watcher stopped, script parked"

# 2. 等弹窗出现
$deadline = (Get-Date).AddSeconds(130)
$popup = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  [void][RwWin]::Scan([uint32]88944, 800000)
  if ([RwWin]::PopupHwnd -ne [IntPtr]::Zero) { $popup = [RwWin]::PopupHwnd; break }
  Start-Sleep -Milliseconds 300
}
if ($popup -eq [IntPtr]::Zero) { Move-Item $bak $script -Force; Write-Output 'no popup in 130s'; exit 0 }

$pet = [RwWin]::FindByTitle('dsh-pet')
Write-Output "popup=$popup pet=$pet"

# 3. 手动抬一次，之后 10 秒不碰任何窗口
$swp = 0x0001 -bor 0x0002 -bor 0x0010
[void][RwWin]::SetWindowPos($pet, [IntPtr](-1), 0, 0, 0, 0, $swp)
Write-Output "one-shot raise done, sampling 10s (no further window ops)"

$prev = $null
$t0 = Get-Date
for ($i = 0; $i -lt 500; $i++) {
  $above = [RwWin]::IsAbove($pet, $popup)
  if ($null -ne $prev -and $above -ne $prev) {
    Write-Output ("t={0}ms above={1}" -f [int]((Get-Date) - $t0).TotalMilliseconds, $above)
  }
  $prev = $above
  Start-Sleep -Milliseconds 20
}
Write-Output ("final above={0}" -f $prev)

# 4. 恢复观察器脚本
if (Test-Path $bak) { Move-Item $bak $script -Force }
Write-Output "script restored"
