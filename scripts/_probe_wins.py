"""只读枚举可见顶层窗口：给截图定位桌宠 / 番茄钟 / 休息弹窗用。"""
import ctypes
from ctypes import wintypes

u = ctypes.windll.user32
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def text(hwnd):
    n = u.GetWindowTextLengthW(hwnd)
    b = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, b, n + 1)
    return b.value


def cls(hwnd):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, b, 256)
    return b.value


def pid_of(hwnd):
    p = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return p.value


def rows():
    out = []

    def cb(hwnd, _):
        if not u.IsWindowVisible(hwnd):
            return True
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w < 40 or h < 40:
            return True
        t, c = text(hwnd), cls(hwnd)
        if not t and c in ("TkTopLevel",):
            t = "(untitled TkTopLevel)"
        out.append((hwnd, t, c, (r.left, r.top, w, h), pid_of(hwnd)))
        return True

    u.EnumWindows(EnumWindowsProc(cb), 0)
    return out


for hwnd, t, c, (x, y, w, h), pid in rows():
    if any(k in (t + c).lower() for k in ("pet", "restnow", "歇会儿", "tomato", "tk", "workbuddy", "dsh")):
        print(f"hwnd={hwnd} pid={pid} cls={c!r} title={t!r} rect=({x},{y},{w},{h})")
print("--- all visible (top 25 by area) ---")
for hwnd, t, c, (x, y, w, h), pid in sorted(rows(), key=lambda r: -r[3][2] * r[3][3])[:25]:
    print(f"hwnd={hwnd} pid={pid} cls={c!r} title={t[:40]!r} rect=({x},{y},{w},{h})")
