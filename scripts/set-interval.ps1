# 用真实输入把「歇会儿」的自定义间隔改成 1 分钟（仅用于联调，之后改回 45）
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class Inp {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@ -ErrorAction SilentlyContinue

$panelLeft = 384
$panelTop = 63
$inputX = $panelLeft + 218
$inputY = $panelTop + 841
Write-Output "clicking custom-interval box at $inputX,$inputY"
[Inp]::ClickAt($inputX, $inputY)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('1')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 800
Write-Output 'done'
