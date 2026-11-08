# RestNow break popup watcher + pet placement helper
#
#  - detects the fullscreen RestNow break popup by window geometry
#  - keeps the pet above the popup: cheap z-chain check every tick, raise only when covered
#  - moves the pet to the centre of the screen (above the text block) during the break
#  - restores the pet immediately after the popup closes
#
# stdout: one JSON object per line
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$ParentPid = 0,
  [int]$IntervalMs = 300,
  [int]$RaisePet = 1,
  [int]$MoveOnBreak = 1,
  [string]$PetTitle = 'dsh-pet',
  [int]$PetApiPort = 43129,
  [string]$PetId = 'main',
  [double]$TargetCenterX = 0.5,
  [double]$TargetBottomY = 0.54,
  [int]$TolerancePx = 40
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'RwWin.cs') -ReferencedAssemblies System.Drawing

$screenW = [RwWin]::ScreenW()
$screenH = [RwWin]::ScreenH()
$script:saved = $null
$script:targetNorm = $null
$script:suppressed = $false
$script:lastSize = ''
$script:petHwnd = [IntPtr]::Zero
$posFile = Join-Path $env:TEMP 'dsh-pet-restnow-pos.json'

function Write-Line([string]$s) {
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
}

function Post-Pos([double]$x, [double]$y, [string]$mode, [int]$durationMs = 0) {
  $body = @{ x = $x; y = $y; mode = $mode } | ConvertTo-Json -Compress
  if ($mode -eq 'line') {
    $body = @{ x = $x; y = $y; mode = 'line'; duration = $durationMs } | ConvertTo-Json -Compress
  }
  $uri = "http://127.0.0.1:$PetApiPort/dsh-pet-7340/position?pet=$PetId&surface=desktop"
  try {
    return Invoke-RestMethod -Uri $uri -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 3
  } catch {
    return $null
  }
}

function Get-BodyBox([IntPtr]$h) {
  $box = [RwWin]::BodyBox($h)
  if ($null -eq $box) { $box = [RwWin]::ContentBox($h) }
  return $box
}

function Get-TargetNorm([IntPtr]$h) {
  $r = [RwWin]::RectOf($h)
  if ($null -eq $r) { return $null }
  $box = Get-BodyBox $h
  if ($null -eq $box) { return $null }
  $bw = $box[2] - $box[0]
  $bh = $box[3] - $box[1]
  if ($bw -le 0 -or $bh -le 0) { return $null }
  $bodyCx = ($box[0] + $box[2]) / 2.0
  $bodyCy = ($box[1] + $box[3]) / 2.0
  $targetCx = $TargetCenterX * $screenW
  $targetCy = $TargetBottomY * $screenH - $bh / 2.0
  $wcX = ($targetCx - $bodyCx) + $r[2] / 2.0
  $wcY = ($targetCy - $bodyCy) + $r[3] / 2.0
  $nx = [Math]::Max(0.0, [Math]::Min(1.0, $wcX / $screenW))
  $ny = [Math]::Max(0.0, [Math]::Min(1.0, $wcY / $screenH))
  return @($nx, $ny)
}

function Move-PetToTextTop {
  Start-Sleep -Milliseconds 250
  $h = [RwWin]::FindByTitle($PetTitle)
  if ($h -eq [IntPtr]::Zero) { return 'no-pet' }
  $r = [RwWin]::RectOf($h)
  if ($null -eq $r) { return 'no-rect' }
  $script:saved = @{ x = (($r[0] + $r[2] / 2.0) / $screenW); y = (($r[1] + $r[3] / 2.0) / $screenH) }
  try { $script:saved | ConvertTo-Json -Compress | Set-Content -Path $posFile -Encoding UTF8 } catch { }
  $t = Get-TargetNorm $h
  if ($null -eq $t) { return 'no-content' }
  Post-Pos $t[0] $t[1] 'line' 700 | Out-Null
  $script:targetNorm = @{ x = $t[0]; y = $t[1] }
  Start-Sleep -Milliseconds 900
  $h2 = [RwWin]::FindByTitle($PetTitle)
  if ($h2 -ne [IntPtr]::Zero) {
    $t2 = Get-TargetNorm $h2
    if ($null -ne $t2) {
      Post-Pos $t2[0] $t2[1] 'instant' | Out-Null
      $script:targetNorm = @{ x = $t2[0]; y = $t2[1] }
      Start-Sleep -Milliseconds 300
    }
  }
  $h3 = [RwWin]::FindByTitle($PetTitle)
  $rectTxt = 'none'
  $bodyTxt = 'none'
  if ($h3 -ne [IntPtr]::Zero) {
    $r3 = [RwWin]::RectOf($h3)
    if ($null -ne $r3) {
      $rectTxt = "$($r3[0]),$($r3[1]),$($r3[2]),$($r3[3])"
      $script:lastSize = "$($r3[2])x$($r3[3])"
    }
    $b3 = Get-BodyBox $h3
    if (($null -ne $r3) -and ($null -ne $b3)) {
      $bl = $r3[0] + $b3[0]
      $bt = $r3[1] + $b3[1]
      $bodyTxt = "$bl,$bt,$($b3[2] - $b3[0]),$($b3[3] - $b3[1])"
    }
  }
  $ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  Write-Line ('{"type":"moved","result":"moved","rect":"' + $rectTxt + '","body":"' + $bodyTxt + '","t":' + $ts + '}')
  return 'moved'
}

function Restore-Pet {
  if ($null -eq $script:saved) {
    try {
      if (Test-Path $posFile) { $script:saved = Get-Content $posFile -Raw | ConvertFrom-Json }
    } catch { }
  }
  if ($null -eq $script:saved) { return 'no-saved' }
  Post-Pos $script:saved.x $script:saved.y 'instant' | Out-Null
  $script:targetNorm = $null
  try { if (Test-Path $posFile) { Remove-Item $posFile -Force -ErrorAction SilentlyContinue } } catch { }
  Write-Line ('{"type":"moved","result":"restored","t":' + [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) + '}')
  return 'restored'
}

function Adjust-PetIfDrifted {
  if ($null -eq $script:targetNorm) { return }
  $h = [RwWin]::FindByTitle($PetTitle)
  if ($h -eq [IntPtr]::Zero) { return }
  $r = [RwWin]::RectOf($h)
  if ($null -eq $r) { return }
  $sizeKey = "$($r[2])x$($r[3])"
  $cx = $r[0] + $r[2] / 2.0
  $cy = $r[1] + $r[3] / 2.0
  $tx = $script:targetNorm.x * $screenW
  $ty = $script:targetNorm.y * $screenH
  $sizeChanged = ($sizeKey -ne $script:lastSize)
  $moved = (([Math]::Abs($cx - $tx) -gt $TolerancePx) -or ([Math]::Abs($cy - $ty) -gt $TolerancePx))
  if ((-not $sizeChanged) -and (-not $moved)) { return }
  $t = Get-TargetNorm $h
  if ($null -eq $t) { return }
  Post-Pos $t[0] $t[1] 'instant' | Out-Null
  $script:targetNorm = @{ x = $t[0]; y = $t[1] }
  $script:lastSize = $sizeKey
  Write-Line ('{"type":"moved","result":"adjusted","t":' + [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) + '}')
}

Write-Line ('{"type":"ready","pid":' + $TargetPid + '}')

$threshold = [int]([RwWin]::ScreenArea() * 0.55)
if ($threshold -lt 1) { $threshold = 1 }
$lastState = 'init'
$tick = 0
$active = $false
$popupW = 0
$popupH = 0

while ($true) {
  $tick++

  if ($ParentPid -ne 0) {
    if ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  }
  if ($null -eq (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
    Write-Line '{"type":"gone"}'
    break
  }

  $needScan = (-not $active) -or (($tick % 20) -eq 0)
  if ($needScan) {
    $raw = ''
    try {
      $raw = [RwWin]::Scan([uint32]$TargetPid, $threshold)
    } catch {
      Write-Line ('{"type":"error","message":"' + ($_.Exception.Message -replace '"', "'") + '"}')
    }
    $active = $false
    $popupW = 0
    $popupH = 0
    foreach ($line in ($raw -split "`n")) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $p = $line.Split('|')
      if ($p.Length -lt 4) { continue }
      if ($p[1] -ne 'TkTopLevel') { continue }
      if (([int]$p[2] * [int]$p[3]) -ge $threshold) {
        $active = $true
        if (([int]$p[2] * [int]$p[3]) -gt ($popupW * $popupH)) {
          $popupW = [int]$p[2]
          $popupH = [int]$p[3]
        }
      }
    }
  }

  $raised = 0
  if ($RaisePet -eq 1) {
    if ($script:petHwnd -eq [IntPtr]::Zero) { $script:petHwnd = [RwWin]::FindByTitle($PetTitle) }
    if ($active) {
      # 交给 C# 的 1ms 守卫线程：只把弹窗插回桌宠下方，桌宠窗口一次都不碰
      [RwWin+ZGuard]::Pet = $script:petHwnd
      if (-not [RwWin+ZGuard]::Running) { [RwWin+ZGuard]::Start() }
    } elseif ([RwWin+ZGuard]::Running) {
      Write-Line ('{"type":"guard","binds":' + [RwWin+ZGuard]::Binds + ',"covered":' + [RwWin+ZGuard]::Covered + ',"actions":' + [RwWin+ZGuard]::Actions + ',"maxGapMs":' + [RwWin+ZGuard]::MaxGapMs + '}')
      [RwWin+ZGuard]::Stop()
    }
  }

  $state = 'idle'
  if ($active) { $state = 'break' }

  if ($state -ne $lastState) {
    $wasInit = ($lastState -eq 'init')
    $lastState = $state
    $ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $flag = 'false'
    if ($active) { $flag = 'true' }
    Write-Line ('{"type":"break","active":' + $flag + ',"w":' + $popupW + ',"h":' + $popupH + ',"raised":' + $raised + ',"t":' + $ts + '}')
    if ($active) {
      if ($wasInit) {
        $script:suppressed = $true
      } elseif ($MoveOnBreak -eq 1) {
        try { [void](Move-PetToTextTop) } catch { Write-Line ('{"type":"error","message":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
      }
    } else {
      if (($MoveOnBreak -eq 1) -and (-not $script:suppressed)) {
        try { [void](Restore-Pet) } catch { Write-Line ('{"type":"error","message":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
      }
      $script:suppressed = $false
    }
  } elseif ($active -and ($MoveOnBreak -eq 1) -and (-not $script:suppressed)) {
    if (($tick % 40) -eq 0) {
      try { Adjust-PetIfDrifted } catch { }
    }
  }

  if ($active) {
    Start-Sleep -Milliseconds 8
  } else {
    Start-Sleep -Milliseconds $IntervalMs
  }
}
