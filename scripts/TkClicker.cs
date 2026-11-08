using System;
using System.Text;
using System.Runtime.InteropServices;

public class TkClicker
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr Best;
    public static int BestW;
    public static int BestH;
    public static int BestL;
    public static int BestT;

    public static void Scan(uint target)
    {
        Best = IntPtr.Zero;
        BestW = 0;
        BestH = 0;
        BestL = 0;
        BestT = 0;
        EnumWindows(delegate(IntPtr hw, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(hw, out pid);
            if (pid != target) return true;
            if (!IsWindowVisible(hw)) return true;
            RECT r;
            if (!GetWindowRect(hw, out r)) return true;
            StringBuilder cls = new StringBuilder(128);
            GetClassName(hw, cls, 128);
            if (cls.ToString() != "TkTopLevel") return true;
            int cw = r.Right - r.Left;
            int ch = r.Bottom - r.Top;
            if (cw * ch > BestW * BestH)
            {
                BestW = cw;
                BestH = ch;
                BestL = r.Left;
                BestT = r.Top;
                Best = hw;
            }
            return true;
        }, IntPtr.Zero);
    }

    public static bool ClickCenter()
    {
        if (Best == IntPtr.Zero) return false;
        int x = BestW / 2;
        int y = BestH / 2;
        IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
        bool down = PostMessage(Best, 0x0201, (IntPtr)1, lp);
        System.Threading.Thread.Sleep(60);
        bool up = PostMessage(Best, 0x0202, IntPtr.Zero, lp);
        return down && up;
    }

    /// <summary>真实输入注入：把光标移到目标窗口中心并按下/抬起左键（会移动用户光标）。</summary>
    public static bool RealClickCenter()
    {
        if (Best == IntPtr.Zero) return false;
        int x = BestL + BestW / 2;
        int y = BestT + BestH / 2;
        SetForegroundWindow(Best);
        System.Threading.Thread.Sleep(150);
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(80);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
}
