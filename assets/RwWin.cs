using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// <summary>
/// 歇会儿观察器用的 Win32 辅助：
///  - 枚举 RestNow 顶层窗口，判定全屏休息弹窗；
///  - 把桌宠窗口保持在弹窗之上（只在真的被压下去时才动手，避免反复重排导致闪烁）；
///  - 量出桌宠窗口里「可见内容」的包围盒，用于把桌宠摆到文字上方。
/// </summary>
public class RwWin
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
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public static IntPtr PopupHwnd;
    public static int PopupW;
    public static int PopupH;

    public static string Scan(uint target, int areaThreshold)
    {
        PopupHwnd = IntPtr.Zero;
        PopupW = 0;
        PopupH = 0;
        StringBuilder sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != target) return true;
            if (!IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.Right - r.Left;
            int hh = r.Bottom - r.Top;
            StringBuilder cls = new StringBuilder(128);
            GetClassName(h, cls, 128);
            sb.Append(h.ToInt64()).Append('|').Append(cls.ToString()).Append('|').Append(w).Append('|').Append(hh).Append('\n');
            if (cls.ToString() == "TkTopLevel" && w * hh >= areaThreshold && w * hh > PopupW * PopupH)
            {
                PopupW = w;
                PopupH = hh;
                PopupHwnd = h;
            }
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    /// <summary>按标题找第一个可见窗口。</summary>
    public static IntPtr FindByTitle(string needle)
    {
        IntPtr found = IntPtr.Zero;
        if (string.IsNullOrEmpty(needle)) return found;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            StringBuilder t = new StringBuilder(256);
            GetWindowText(h, t, 256);
            if (t.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static int[] RectOf(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return null;
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr h, int idx);

    /// <summary>窗口当前是否带 WS_EX_TOPMOST。</summary>
    public static bool IsTopmost(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        return (GetWindowLong(h, -20) & 0x8) != 0;
    }

    /// <summary>把窗口设回置顶层（不移动、不改大小、不抢焦点）。</summary>
    public static bool SetTopmost(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        return SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    /// <summary>
    /// 把 target 插到 above 的正下方（两者同属置顶层时有效）。
    /// 关键点：**只动 target，不动桌宠窗口**——桌宠不重排、不重绘，就不会出现明暗闪。
    /// </summary>
    public static bool PlaceBelow(IntPtr target, IntPtr above)
    {
        if (target == IntPtr.Zero || above == IntPtr.Zero) return false;
        return SetWindowPos(target, above, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    /// <summary>
    /// 把窗口降出置顶层（不移动、不改大小、不抢焦点）。
    /// 用途：弹窗自己反复重申置顶时，降它而不是抬桌宠——桌宠窗口完全不重绘，因此不会出现明暗闪。
    /// </summary>
    public static bool Demote(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        return SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr64(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    static extern IntPtr SetWindowLongPtr64(IntPtr h, int idx, IntPtr val);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    static extern int GetWindowLong32(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    static extern int SetWindowLong32(IntPtr h, int idx, int val);

    const int GWLP_HWNDPARENT = -8;   // 对顶层窗口，这一项设的是 owner（不是 parent）

    public static IntPtr GetOwner(IntPtr h)
    {
        if (h == IntPtr.Zero) return IntPtr.Zero;
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(h, GWLP_HWNDPARENT)
            : new IntPtr(GetWindowLong32(h, GWLP_HWNDPARENT));
    }

    /// <summary>
    /// 把桌宠设为弹窗的 owned window：Windows 保证 owned window 永远显示在 owner 之上，
    /// 且不受双方重申 WS_EX_TOPMOST 的影响 —— 这是「零轮询纠正」的根治办法。
    /// 只改 z 序归属关系，不改 parent、不触发窗口重建。
    /// </summary>
    public static IntPtr SetOwner(IntPtr h, IntPtr owner)
    {
        if (h == IntPtr.Zero) return IntPtr.Zero;
        return IntPtr.Size == 8
            ? SetWindowLongPtr64(h, GWLP_HWNDPARENT, owner)
            : new IntPtr(SetWindowLong32(h, GWLP_HWNDPARENT, owner.ToInt32()));
    }

    /// <summary>
    /// 便宜的 z 序比较：a 是否在 b 之上。只沿 z 链走一遍，不取窗口标题，开销远小于 EnsureAbove。
    /// 任一窗口为 Zero 时返回 true（当作无需处理）。
    /// </summary>
    public static bool IsAbove(IntPtr a, IntPtr b)
    {
        if (a == IntPtr.Zero || b == IntPtr.Zero) return true;
        IntPtr h = GetTopWindow(IntPtr.Zero);
        int guard = 0;
        while (h != IntPtr.Zero && guard++ < 4000)
        {
            if (h == a) return true;
            if (h == b) return false;
            h = GetWindow(h, 2); // GW_HWNDNEXT
        }
        return true;
    }

    /// <summary>
    /// 把桌宠抬到弹窗之上，但**只在它当前确实位于弹窗之下时才动手**：
    /// 每轮无条件 SetWindowPos(HWND_TOPMOST) 会让透明窗反复重排，表现为明暗闪烁。
    /// 返回本次真正抬起的窗口数（0 = 本来就在上面，什么都没做）。
    /// </summary>
    public static int EnsureAbove(IntPtr popup, string needle)
    {
        if (popup == IntPtr.Zero || string.IsNullOrEmpty(needle)) return 0;
        int idx = 0;
        int popupIdx = -1;
        List<IntPtr> pets = new List<IntPtr>();
        List<int> petIdx = new List<int>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (h == popup && popupIdx < 0) popupIdx = idx;
            if (IsWindowVisible(h))
            {
                StringBuilder t = new StringBuilder(256);
                GetWindowText(h, t, 256);
                if (t.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    pets.Add(h);
                    petIdx.Add(idx);
                }
            }
            idx++;
            return true;
        }, IntPtr.Zero);
        if (popupIdx < 0) return 0;
        int raised = 0;
        for (int i = 0; i < pets.Count; i++)
        {
            if (petIdx[i] > popupIdx)
            {
                if (SetWindowPos(pets[i], HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)) raised++;
            }
        }
        return raised;
    }

    /// <summary>
    /// 量出窗口内可见内容的包围盒（打印窗口后按 alpha/亮度剔除透明与纯黑）。
    /// 返回 [minX, minY, maxX, maxY]（窗口客户坐标），量不到返回 null。
    /// </summary>
    public static int[] ContentBox(IntPtr hwnd)
    {
        int[] rect = RectOf(hwnd);
        if (rect == null) return null;
        int w = rect[2];
        int hh = rect[3];
        if (w <= 0 || hh <= 0 || w > 8000 || hh > 8000) return null;

        using (Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok = PrintWindow(hwnd, hdc, 2);
                g.ReleaseHdc(hdc);
                if (!ok) return null;
            }
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, hh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                byte[] buf = new byte[stride * hh];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                int minX = w, minY = hh, maxX = -1, maxY = -1;
                for (int y = 0; y < hh; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++)
                    {
                        int p = row + x * 4;
                        byte b = buf[p], gg = buf[p + 1], rr = buf[p + 2], aa = buf[p + 3];
                        if (aa > 16 && (rr + gg + b) > 24)
                        {
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }
                }
                if (maxX < 0) return null;
                return new int[] { minX, minY, maxX, maxY };
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }
    }

    /// <summary>
    /// 只量「本体」（角色），不含头顶气泡与图标：取内容包围盒下半部分（>45% 高度）的像素范围。
    /// 用于把角色本身摆到屏幕正中，而不是让气泡把构图带偏。
    /// 返回 [minX, minY, maxX, maxY]（窗口坐标），量不到返回 null。
    /// </summary>
    public static int[] BodyBox(IntPtr hwnd)
    {
        int[] rect = RectOf(hwnd);
        if (rect == null) return null;
        int w = rect[2];
        int hh = rect[3];
        if (w <= 0 || hh <= 0 || w > 8000 || hh > 8000) return null;

        using (Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr hdc = g.GetHdc();
                bool ok = PrintWindow(hwnd, hdc, 2);
                g.ReleaseHdc(hdc);
                if (!ok) return null;
            }
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, hh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                byte[] buf = new byte[stride * hh];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);

                int cMinX = w, cMinY = hh, cMaxX = -1, cMaxY = -1;
                for (int y = 0; y < hh; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++)
                    {
                        int p = row + x * 4;
                        byte b = buf[p], gg = buf[p + 1], rr = buf[p + 2], aa = buf[p + 3];
                        if (aa > 16 && (rr + gg + b) > 24)
                        {
                            if (x < cMinX) cMinX = x;
                            if (x > cMaxX) cMaxX = x;
                            if (y < cMinY) cMinY = y;
                            if (y > cMaxY) cMaxY = y;
                        }
                    }
                }
                if (cMaxX < 0) return null;

                int cut = cMinY + (int)((cMaxY - cMinY) * 0.45);
                int minX = w, minY = hh, maxX = -1, maxY = -1;
                for (int y = cut; y <= cMaxY; y++)
                {
                    int row = y * stride;
                    for (int x = 0; x < w; x++)
                    {
                        int p = row + x * 4;
                        byte b = buf[p], gg = buf[p + 1], rr = buf[p + 2], aa = buf[p + 3];
                        if (aa > 16 && (rr + gg + b) > 24)
                        {
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }
                }
                if (maxX < 0) return new int[] { cMinX, cMinY, cMaxX, cMaxY };
                return new int[] { minX, minY, maxX, maxY };
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }
    }

    public static int ScreenW() { return GetSystemMetrics(0); }
    public static int ScreenH() { return GetSystemMetrics(1); }

    /// <summary>
    /// 防闪烁守卫：把桌宠设为全屏弹窗的 owned window，由 Windows 保证它恒在弹窗之上。
    /// 不再轮询纠正 z 序（那会和 Tk 反复重申 topmost 形成拉锯，正是明暗闪的真因）。
    /// 只在 owner 不生效时低频兜底，并在退出时还原 owner。
    /// </summary>
    public class ZGuard
    {
        [DllImport("winmm.dll")]
        static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")]
        static extern uint timeEndPeriod(uint ms);

        static Thread worker;
        static volatile bool running;

        public static IntPtr Pet;
        public static long Actions;      // 兜底纠正次数（owner 生效时应 ≈ 0）
        public static long MaxGapMs;     // 鱼被压最长连续时长（owner 生效时应 ≈ 0）
        public static long Binds;        // owner 绑定成功次数
        public static long Covered;      // 绑定后仍被压的采样次数（诊断 owner 是否生效）

        public static bool Running { get { return running; } }

        public static void Start()
        {
            Stop();
            running = true;
            Actions = 0;
            MaxGapMs = 0;
            Binds = 0;
            Covered = 0;
            worker = new Thread(Loop);
            worker.IsBackground = true;
            worker.Priority = ThreadPriority.AboveNormal;
            worker.Start();
        }

        public static void Stop()
        {
            running = false;
            worker = null;
        }

        static void Loop()
        {
            timeBeginPeriod(1);
            Stopwatch gap = new Stopwatch();
            bool covered = false;
            long lastFallback = 0;
            IntPtr boundPet = IntPtr.Zero;
            IntPtr boundPopup = IntPtr.Zero;
            IntPtr savedOwner = IntPtr.Zero;
            try
            {
                while (running)
                {
                    IntPtr pet = Pet;
                    IntPtr popup = PopupHwnd;
                    bool petAlive = pet != IntPtr.Zero && IsWindow(pet);
                    bool popupAlive = popup != IntPtr.Zero && IsWindow(popup);

                    // ★★★ 闪烁的真因（1.4.4 前一直没治好）：
                    //   旧逻辑每轮 Demote(popup) 把遮罩踢出置顶层，而 Tk 全屏弹窗有帧循环、
                    //   会周期性重申 -topmost 把自己拉回置顶层顶端 ⇒ 一降一升无限拉锯，
                    //   鱼每轮在「遮罩之上（亮）/ 遮罩之下（暗）」切一帧 = 肉眼可见的明暗闪。
                    //   任何「靠轮询纠正 z 序」的方案都消不掉它：Tk 重申那一帧必然压住鱼。
                    // 根治：把鱼设为弹窗的 **owned window**。Windows 保证 owned window
                    //   恒在 owner 之上，双方怎么重申 topmost 都不改变 ⇒ 零 z 序动作 = 零重绘 = 零闪。

                    // 弹窗句柄短暂为 0 时**什么都别做**：ps1 的 Scan() 每 ~160ms 会先把
                    // PopupHwnd 清零再重扫，若在此刻解绑就会反复改 owner、反而引入新的闪。
                    // 真正解绑交给「换绑」和 finally（watcher Stop 时）。
                    if (petAlive && popupAlive && (boundPet != pet || boundPopup != popup))
                    {
                        if (boundPet != IntPtr.Zero && IsWindow(boundPet)) SetOwner(boundPet, savedOwner);
                        savedOwner = GetOwner(pet);
                        SetOwner(pet, popup);
                        boundPet = pet;
                        boundPopup = popup;
                        if (GetOwner(pet) == popup) Binds++;
                        covered = false;
                        gap.Stop();
                        lastFallback = 0;
                    }

                    if (boundPet != IntPtr.Zero && IsWindow(boundPet))
                    {
                        if (!IsAbove(boundPet, boundPopup))
                        {
                            // 诊断：owner 已绑但鱼仍被压（说明该窗口不接受跨进程 owner）
                            Covered++;
                            if (!covered) { covered = true; gap.Restart(); }
                            else if (gap.ElapsedMilliseconds > MaxGapMs) MaxGapMs = gap.ElapsedMilliseconds;
                            // 兜底：低频、幂等地把弹窗插回鱼下方。**绝不 Demote** —— 那会重新拉开拉锯。
                            long since = (Stopwatch.GetTimestamp() - lastFallback) * 1000 / Stopwatch.Frequency;
                            if (lastFallback == 0 || since >= 500)
                            {
                                if (!IsTopmost(boundPet)) SetTopmost(boundPet);
                                PlaceBelow(boundPopup, boundPet);
                                lastFallback = Stopwatch.GetTimestamp();
                                Actions++;
                            }
                        }
                        else if (covered)
                        {
                            covered = false;
                            gap.Stop();
                            if (gap.ElapsedMilliseconds > MaxGapMs) MaxGapMs = gap.ElapsedMilliseconds;
                        }
                    }
                    Thread.Sleep(16);
                }
            }
            finally
            {
                // 无论怎么退出，都把 owner 还原，别把桌宠永久挂到弹窗上
                try { if (boundPet != IntPtr.Zero && IsWindow(boundPet)) SetOwner(boundPet, savedOwner); }
                catch { }
                timeEndPeriod(1);
            }
        }
    }

    public static int ScreenArea() { return GetSystemMetrics(0) * GetSystemMetrics(1); }
}
