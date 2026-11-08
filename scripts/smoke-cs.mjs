// RwWin.cs 静态结构检查。
// ★ 如实标注：本沙箱**禁止 C# 编译**（`csc.exe` / `Add-Type` 被安全策略以
//   「compiles arbitrary C# code」直接拦下，2026-11-07 用 PowerShell 工具直调
//   .NET Framework csc.exe 复验仍被拦）⇒ 这里**不是编译级验证**，别对外这么写。
//   真机的 PowerShell watcher 启动时会用 Add-Type 真正编译一次。
//   能做的是把「编译器本该抓到的结构错误」用可跑红绿的断言兜住：括号配对、
//   每个 DllImport 必须跟 extern、禁在窗口过程里改扩展样式、新 owner API、
//   以及「Loop 里绝不再出现会引发拉锯的 Demote」这条反向守卫。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// RWWIN_CS 可指向临时变体，供「正控」用（不碰产品文件）
const src = readFileSync(process.env.RWWIN_CS || join(root, 'assets', 'RwWin.cs'), 'utf8');
let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// 去掉字符串字面量与注释后的配对检查（粗略但能抓住漏括号/多余括号）
const stripped = src
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const balance = (open, close) => {
  let n = 0;
  for (const ch of stripped) {
    if (ch === open) n++;
    else if (ch === close) n--;
    if (n < 0) return -1;
  }
  return n;
};
ck('花括号配对', balance('{', '}') === 0, { delta: balance('{', '}') });
ck('圆括号配对', balance('(', ')') === 0, { delta: balance('(', ')') });
ck('方括号配对', balance('[', ']') === 0, { delta: balance('[', ']') });

ck('引用了 System.Drawing / Runtime.InteropServices',
  src.includes('using System.Drawing;') && src.includes('using System.Runtime.InteropServices;'));
// ★ 编译器本该抓到的第一件事：P/Invoke 声明漏了 extern。逐个 DllImport 对账，
//   不写「至少出现 N 次 extern」这种会被别处 extern 顶成恒绿的假判据。
const pinvokes = [...stripped.matchAll(/\[DllImport\([^\]]*\)\]\s*([\s\S]{0,240}?);/g)];
ck('★ 每个 [DllImport] 后都紧接 extern 声明（编译级结构检查）',
  pinvokes.length >= 10 && pinvokes.every((m) => /\bextern\b/.test(m[1])),
  { count: pinvokes.length, bad: pinvokes.filter((m) => !/\bextern\b/.test(m[1])).map((m) => m[1].slice(0, 80)) });
// ★ 历史事故：在窗口过程里改 GWL_EXSTYLE / WS_EX_LAYERED 会重入本回调 →
//   AppHangB1 + BEX64、rc=0xC0000409、error.log 无异常。只允许读（-20），不许写。
const exWrites = stripped.split('\n')
  .filter((l) => /SetWindowLong/.test(l) && /-20|WS_EX_LAYERED|GWL_EXSTYLE/.test(l));
ck('★ 没有任何写扩展样式的 P/Invoke 调用（防窗口过程重入崩溃）',
  exWrites.length === 0, exWrites);
ck('★ x64 / x86 的 SetWindowLong 都显式指定 EntryPoint',
  /EntryPoint = "SetWindowLongPtrW"/.test(src) && /EntryPoint = "SetWindowLongW"/.test(src));
ck('★ SetOwner 对空句柄直接返回（不把 owner 指向 0）',
  /public static IntPtr SetOwner\([\s\S]{0,260}?h == IntPtr\.Zero/.test(stripped));
ck('owner API 已声明（GetOwner/SetOwner/IsWindow）',
  /public static IntPtr GetOwner\(/.test(src)
  && /public static IntPtr SetOwner\(/.test(src)
  && /public static extern bool IsWindow\(/.test(src));
ck('GWLP_HWNDPARENT = -8（顶层窗口设置的是 owner 而非 parent）',
  /const int GWLP_HWNDPARENT = -8;/.test(src));
ck('64/32 位分支都用了 Ptr 版，避免 x64 句柄被截断',
  /IntPtr\.Size == 8/.test(src) && /SetWindowLongPtr64/.test(src) && /SetWindowLong32/.test(src));
ck('诊断计数 Binds / Covered 已暴露',
  /public static long Binds;/.test(src) && /public static long Covered;/.test(src));
ck('退出时还原 owner（finally 里 SetOwner(boundPet, savedOwner)）',
  /finally[\s\S]{0,600}SetOwner\(boundPet, savedOwner\)/.test(src));

// ★ 反向守卫：正控——把 Demote 调用塞回 Loop，这条必须变红。
const loopStart = src.indexOf('static void Loop()');
const loopEnd = src.indexOf('public static int ScreenArea()');
const rawLoop = loopStart >= 0 ? src.slice(loopStart, loopEnd > 0 ? loopEnd : undefined) : '';
// ★ 必须先剥注释/字符串：Loop 的历史说明注释里就写着「旧逻辑每轮 Demote(popup)」，
//   不剥会对注释里的字面量误报（断言要写语义，不是写手段）。
const strip = (s) => s
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const loop = strip(rawLoop);
ck('Loop 成立且包含 owner 绑定', loop.length > 500 && loop.includes('SetOwner(pet, popup)'));
ck('★ Loop 里不再调用 Demote（否则与 Tk 的 topmost 重申拉锯 = 明暗闪）',
  !/Demote\s*\(/.test(loop));
ck('★ 兜底仍用 PlaceBelow 且带 500ms 节流',
  loop.includes('PlaceBelow(boundPopup, boundPet)') && loop.includes('since >= 500'));
const bindAt = loop.indexOf('SetOwner(pet, popup)');
const fallbackAt = loop.indexOf('PlaceBelow(boundPopup, boundPet)');
ck('★ Loop 里先绑 owner、后走 PlaceBelow 兜底（正常路径零 z 序动作）',
  bindAt >= 0 && fallbackAt >= 0 && bindAt < fallbackAt, { bindAt, fallbackAt });
ck('★ popup 句柄短暂为 0 时保持不动（避开 Scan 重置抖动）',
  loop.includes('popupAlive') && !/if\s*\(!popupAlive[\s\S]{0,120}SetOwner\(boundPet, savedOwner\)/.test(loop));

console.log(`\nRwWin.cs 静态检查：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
