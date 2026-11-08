#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
商城真机截图 01 / 02 的 OS 层助手（只读窗口 + 抓屏 + 合成右键 + Esc）。

为什么单独一个 py：Node 没有可用的桌面抓屏 / 鼠标注入能力；本机
`health312` venv 有 PIL + ctypes，且沙箱允许它抓真实桌面。

★ 三条硬规矩：
  1. **锁屏就拒绝**（前台是 Windows 锁屏界面时抓回来的是壁纸+大时钟，
     尺寸、非空、不像坏图 —— 最容易骗过自己的假证据，见 _ref_sandbox.md §截图）；
  2. **不伪造画面**：只做「抓真实屏幕 → 裁切 → 缩放」，不画任何 UI；
  3. **右键菜单必须自检**：靠前后帧差分确认菜单真弹出来了，找不到就换候选点，
     全失败就报错退出，绝不把没菜单的图当 02 交出去。

子命令（都输出 JSON 到 stdout，便于 Node 侧解析）：
  probe                         锁屏 / 屏幕 / 缩放比 / 桌宠窗 / 全屏弹窗
  fullscreen <out.png> [w h]    抓全屏 → 缩放 → 保存 01
  menu <out.png> [w h] [x y]    合成右键 → 差分自检 → 裁切 → 保存 02 → Esc
"""
import atexit
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes

from PIL import Image, ImageChops, ImageGrab

u = ctypes.windll.user32
SW_MINIMIZE = 6
SW_RESTORE = 9

# ★ 桌宠不是常驻 topmost：只有休息弹窗出现时才被设成 owned window 恒在上。
#   平时用户切回 WorkBuddy，它就把桌宠盖住 ⇒ 右键注入全打到别的窗口上，
#   差分自检就会诚实地报「菜单没弹出」。拍摄前临时最小化遮挡窗，
#   用 atexit 保证**任何退出路径**（含 sys.exit / 异常）都还原，绝不留着别人的窗口最小化。
_RESTORE = []
_RESTORE_POS = []
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
MOVE_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE


def _restore_all():
    for hwnd, x, y in _RESTORE_POS:
        try:
            u.SetWindowPos(hwnd, 0, x, y, 0, 0, MOVE_FLAGS)
        except Exception:
            pass
    for hwnd in _RESTORE:
        try:
            u.ShowWindow(hwnd, SW_RESTORE)
        except Exception:
            pass


atexit.register(_restore_all)


def clear_occluders(names=("WorkBuddy", "酷我音乐"), classes=("kwmusicmaindlg",)):
    """临时最小化会盖住桌宠 / 会进背景的大窗口，atexit 自动还原。

    ★ 背景也得上心：只最小化 WorkBuddy 时，后面露出的酷我音乐会把歌名 /
      专辑封面带进商城截图（第三方内容），所以按标题 + 窗口类一起收掉。
    ★ 番茄钟是独立分层 Tk 窗，恒在菜单之上：不挪开会压住「更多」子菜单的
      「立即休息」半行。临时挪到左上角、拍完用同一组 Win32 坐标还原。
    """
    for w in windows():
        t = w["title"] or ""
        if any(n in t for n in names) or w["cls"] in classes:
            u.ShowWindow(w["hwnd"], SW_MINIMIZE)
            _RESTORE.append(w["hwnd"])
        elif w["cls"] == "TkTopLevel" and "歇会儿" in t:
            x, y = w["rect"][0], w["rect"][1]
            _RESTORE_POS.append((w["hwnd"], x, y))
            u.SetWindowPos(w["hwnd"], 0, 20, 20, 0, 0, MOVE_FLAGS)
    if _RESTORE or _RESTORE_POS:
        time.sleep(0.6)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
VK_ESCAPE = 0x1B
KEYEVENTF_KEYUP = 0x0002


def _buf(n=512):
    return ctypes.create_unicode_buffer(n)


def windows():
    """枚举可见顶层窗口；坐标按本进程 DPI 感知返回（可能是逻辑像素）。"""
    out = []

    def cb(hwnd, _lparam):
        if not u.IsWindowVisible(hwnd):
            return True
        cls, txt = _buf(256), _buf(512)
        u.GetClassNameW(hwnd, cls, 256)
        u.GetWindowTextW(hwnd, txt, 512)
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        out.append({
            "hwnd": int(hwnd),
            "pid": int(pid.value),
            "cls": cls.value,
            "title": txt.value,
            "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
        })
        return True

    u.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def screen():
    """返回 (物理宽高, 逻辑宽高, 缩放比)。Win32 矩形一律乘 scale 才是抓屏坐标。

    ★ scale 必须是**单个浮点数**：早期写成 (sx, sy) 二元组，结果 `v * scale`
      变成「序列重复」（`0 * (1.5, 1.5)` 得 `()`），后面 round() 直接炸。
    """
    im = ImageGrab.grab(all_screens=True)
    pw, ph = im.size
    lw, lh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    if not lw or not lh:
        lw, lh = pw, ph
    return (pw, ph), (lw, lh), pw / lw


def is_locked(wins):
    h = u.GetForegroundWindow()
    cls, txt = _buf(256), _buf(512)
    u.GetClassNameW(h, cls, 256)
    u.GetWindowTextW(h, txt, 512)
    t = txt.value or ""
    # 中文/英文 Windows 锁屏窗口标题；再兜一条「整屏 CoreWindow 且无标题」的常见形态
    if "锁屏" in t or "Lock screen" in t.lower():
        return True, {"hwnd": int(h), "cls": cls.value, "title": t}
    if h == 0:
        return True, {"hwnd": 0, "cls": "", "title": ""}
    return False, {"hwnd": int(h), "cls": cls.value, "title": t}


def find(wins, scale):
    pet, popups = None, []
    for w in wins:
        x, y, cw, ch = [v * scale for v in w["rect"]]
        rect = [round(v) for v in (x, y, cw, ch)]
        t = w["title"] or ""
        if ("dsh-pet" in t or "桌宠" in t) and w["cls"] == "Chrome_WidgetWin_1":
            pet = {"hwnd": w["hwnd"], "rect": rect, "title": t}
        # 歇会儿的全屏休息弹窗：Tk 顶层窗，面积 >= 屏幕 55%
        if w["cls"] == "TkTopLevel" and cw * ch > 0:
            popups.append({"hwnd": w["hwnd"], "rect": rect, "title": t})
    return pet, popups


def probe():
    (pw, ph), (lw, lh), scale = screen()
    wins = windows()
    locked, fg = is_locked(wins)
    pet, popups = find(wins, scale)
    big = [p for p in popups if p["rect"][2] * p["rect"][3] >= pw * ph * 0.55]
    return {
        "locked": locked,
        "foreground": fg,
        "screen": [pw, ph],
        "logical": [lw, lh],
        "scale": round(scale, 4),
        "pet": pet,
        "fullscreenPopup": big[0] if big else None,
        "tkWindows": popups,
    }


def grab_rgb():
    return ImageGrab.grab(all_screens=True).convert("RGB")


def right_click(px, py, scale):
    """px/py 是抓屏物理坐标；SetCursorPos 用本进程坐标系 ⇒ 要除以 scale。"""
    u.SetCursorPos(int(px / scale), int(py / scale))
    time.sleep(0.12)
    u.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
    time.sleep(0.06)
    u.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)


def esc():
    u.keybd_event(VK_ESCAPE, 0, 0, 0)
    time.sleep(0.05)
    u.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0, 0)


def looks_like_menu(im, bb, threshold=0.12):
    """★ 反假绿：只判「屏幕变了」会被任意整屏变化骗过。

    2026-11-07 实证：拍 02 时歇会儿的番茄钟正好到点，全屏休息弹窗自己弹出来，
    差分 116182 px 全绿，交出来的却是「该歇会儿了」而不是右键菜单。
    dsh-pet 的菜单是浅色面板，全屏休息弹窗是深色遮罩 ⇒ 用亮像素占比把它们分开。
    """
    c = im.crop(bb).convert("L")
    if not c.size[0] or not c.size[1]:
        return False
    hist = c.histogram()
    bright = sum(hist[190:])
    return bright / (c.size[0] * c.size[1]) >= threshold


def changed_pixels(a, b, box=None, threshold=40):
    """前后帧差分：返回 (变化像素数, 变化区域 bbox)。用来确认右键菜单真的弹了。"""
    if box:
        a, b = a.crop(box), b.crop(box)
    d = ImageChops.difference(a, b).convert("L")
    mask = d.point(lambda p: 255 if p > threshold else 0)
    hist = mask.histogram()
    count = hist[255]
    bb = mask.getbbox()
    if bb and box:
        bb = (bb[0] + box[0], bb[1] + box[1], bb[2] + box[0], bb[3] + box[1])
    return count, bb


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def fit_box(*, im, box, out_w, out_h):
    """fit_crop 的纯计算版：只求裁切框，不裁图。悬停坐标反算要用。"""
    pw, ph = im.size
    x0, y0, x1, y1 = box
    want = out_w / out_h
    cw, ch = x1 - x0, y1 - y0
    if cw / ch > want:
        ch = cw / want
    else:
        cw = ch * want
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    x0, y0, x1, y1 = cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2
    if x0 < 0:
        x1 -= x0
        x0 = 0
    if y0 < 0:
        y1 -= y0
        y0 = 0
    if x1 > pw:
        x0 -= x1 - pw
        x1 = pw
    if y1 > ph:
        y0 -= y1 - ph
        y1 = ph
    return (int(clamp(x0, 0, pw)), int(clamp(y0, 0, ph)),
            int(clamp(x1, 0, pw)), int(clamp(y1, 0, ph)))


def fit_crop(im, box, out_w, out_h):
    """把 box 补成目标宽高比后裁切（尽量居中、不越界），再缩放。"""
    return im.crop(fit_box(im=im, box=box, out_w=out_w, out_h=out_h)) \
        .resize((out_w, out_h), Image.LANCZOS)


def require_unlocked():
    p = probe()
    if p["locked"]:
        print(json.dumps({"ok": False, "why": "locked", "probe": p}, ensure_ascii=False))
        sys.exit(3)
    return p


def cmd_fullscreen(out, w, h):
    p = require_unlocked()
    im = grab_rgb()
    im.resize((w, h), Image.LANCZOS).save(out, "PNG")
    print(json.dumps({
        "ok": True, "file": out, "width": w, "height": h,
        "popupSeen": p["fullscreenPopup"] is not None,
        "screen": p["screen"],
    }, ensure_ascii=False))


def cmd_menu(out, w, h, explicit, more=False, hover=None):
    p = require_unlocked()
    clear_occluders()
    p = probe()          # 最小化后桌宠窗口位置可能变，必须重取
    pet = p["pet"]
    if not pet:
        print(json.dumps({"ok": False, "why": "pet-window-not-found", "probe": p}, ensure_ascii=False))
        sys.exit(4)
    pw, ph = p["screen"]
    scale = p["scale"]
    x, y, cw, ch = pet["rect"]

    # 桌宠窗口是一整块带大量透明留边的画布，角色落点会随停靠角/拖拽变化：
    # 2026-11-07 两次真机实测分别是 (0.24,0.58) 与 (0.50,0.60)。
    # 所以这里给一组候选锚点，靠前后帧差分自检挑中真正弹出菜单的那个，
    # 全不中再让用户用 --click 指定，绝不静默交出没菜单的图。
    fractions = [(0.50, 0.60), (0.24, 0.58), (0.30, 0.55), (0.20, 0.66), (0.38, 0.50), (0.50, 0.50)]
    candidates = [(clamp(x + cw * fx, 0, pw), clamp(y + ch * fy, 0, ph)) for fx, fy in fractions]
    if explicit:
        candidates.insert(0, tuple(explicit))

    base = grab_rgb()
    found = None
    shot = None
    i, tries = 0, 0
    while i < len(candidates) and tries < len(candidates) + 4:
        tries += 1
        cx, cy = candidates[i]
        right_click(cx, cy, scale)
        time.sleep(0.65)
        cur = grab_rgb()
        # 只看点击点右下方的菜单可能出现区，避开桌宠自身动画造成的差分
        box = (int(clamp(cx - 40, 0, pw)), int(clamp(cy - 40, 0, ph)),
               int(clamp(cx + 900, 0, pw)), int(clamp(cy + 760, 0, ph)))
        count, bb = changed_pixels(base, cur, box)
        area = (bb[2] - bb[0]) * (bb[3] - bb[1]) if bb else 0
        bright = looks_like_menu(cur, bb) if bb else False
        # 到点的全屏休息弹窗会自己盖满屏幕：Esc 收掉、刷新基线、重试**同一个**点。
        if probe()["fullscreenPopup"] is not None:
            esc()
            time.sleep(0.7)
            base = grab_rgb()
            continue
        # 菜单 = 局部浅色面板；整屏深色遮罩 / 桌宠动画都不算。
        if count >= 12000 and bb and area < pw * ph * 0.45 and bright:
            found = {
                "cx": cx, "cy": cy, "changed": count, "bbox": bb,
                "changedArea": area, "lightPanel": bright, "attempt": i + 1,
            }
            shot = cur
            break
        esc()  # 这次没命中（或菜单没弹出），收掉再试下一个点
        time.sleep(0.25)
        base = grab_rgb()
        i += 1

    if not found:
        print(json.dumps({
            "ok": False, "why": "context-menu-not-detected",
            "hint": "用 --click <物理X> <物理Y> 指定桌宠身体中心后重试",
            "tried": candidates, "probe": p,
        }, ensure_ascii=False))
        sys.exit(5)

    cx, cy = found["cx"], found["cy"]
    bx0, by0, bx1, by1 = found["bbox"]
    # 裁切范围 = 菜单变化区 ∪ 桌宠身体附近，保证「点鱼 + 菜单」都在画面里
    box = (
        min(bx0, cx - 320) - 30, min(by0, cy - 260) - 30,
        max(bx1, cx + 260) + 30, max(by1, cy + 260) + 30,
    )
    # ★ 记录实际裁切框：输出图像素 ↔ 物理屏幕坐标的换算全靠它。
    crop_box = fit_box(im=shot, box=box, out_w=w, out_h=h)
    hovered = None
    root_shot = None
    if more:
        # 留一帧「根菜单」诊断图：万一「更多」没展开，能直接看图校准坐标，
        # 而不是对着一张没有菜单的成品猜。放 .icon-work，不污染 market/screenshots。
        root_shot = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                 ".icon-work", "_menu_root.png")
        try:
            shot.crop(crop_box).resize((w, h), Image.LANCZOS).save(root_shot, "PNG")
        except Exception:
            root_shot = None
        # 根菜单挂在点击点附近、被 clamp 到窗口 ∩ 工作区右侧；差分 bbox 就是它。
        # 「更多」是最后一行 → 默认取 bbox 底部靠右；也可从 CLI 显式传 --hover。
        hx, hy = hover if hover else (bb[2] - 60, bb[3] - 25)
        u.SetCursorPos(int(hx / scale), int(hy / scale))
        time.sleep(0.55)
        cur2 = grab_rgb()
        # ★ 反向守卫：shared-core 的 root 有 mouseleave → 200ms 自动 close()。
        #   悬停点跑到菜单外，菜单会悄悄消失；不判这一条就会交出「没有菜单的 02」。
        if not looks_like_menu(cur2, bb):
            esc()
            print(json.dumps({
                "ok": False, "why": "menu-closed-by-hover",
                "hover": [round(hx), round(hy)], "bbox": bb,
                "rootShot": root_shot, "cropBox": crop_box,
            }, ensure_ascii=False))
            sys.exit(6)
        shot = cur2
        hovered = [round(hx), round(hy)]
    shot.crop(crop_box).resize((w, h), Image.LANCZOS).save(out, "PNG")
    esc()
    print(json.dumps({
        "ok": True, "file": out, "width": w, "height": h,
        "menu": found, "cropBox": crop_box, "moreHovered": hovered,
        "screen": [pw, ph],
    }, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "why": "usage"}, ensure_ascii=False))
        sys.exit(2)
    cmd = args[0]
    if cmd == "probe":
        print(json.dumps({"ok": True, **probe()}, ensure_ascii=False))
        return
    if cmd == "fullscreen":
        w = int(args[2]) if len(args) > 2 else 1280
        h = int(args[3]) if len(args) > 3 else 800
        cmd_fullscreen(args[1], w, h)
        return
    if cmd in ("menu", "menu-more"):
        w = int(args[2]) if len(args) > 2 else 800
        h = int(args[3]) if len(args) > 3 else 600
        pair = lambda flag: (  # noqa: E731
            (int(args[args.index(flag) + 1]), int(args[args.index(flag) + 2]))
            if flag in args and args.index(flag) + 2 < len(args) else None
        )
        cmd_menu(args[1], w, h, pair("--click"),
                 more=(cmd == "menu-more"), hover=pair("--hover"))
        return
    print(json.dumps({"ok": False, "why": "unknown-command", "cmd": cmd}, ensure_ascii=False))
    sys.exit(2)


if __name__ == "__main__":
    main()
