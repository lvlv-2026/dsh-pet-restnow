/**
 * 商店 MSIX 版「能不能静默进番茄钟」的只读查证器。
 *
 * 背景：1.4.6 对安装版 / 官网版用 `--startup` 做到「只出番茄钟」，
 * 但 MSIX 走 `explorer.exe shell:AppsFolder\<AppID>`，Explorer 不转发参数。
 * 本脚本去读本机已安装的 AppxManifest.xml，把「有没有别的激活入口」查实，
 * 而不是拍脑袋写结论。
 *
 * ★ 它同时是一道**回归守卫**：若将来的商店包加了 AppExecutionAlias 或
 *   uap:Protocol（两者都能带参数启动），本脚本会报红，提醒我们回来实现，
 *   否则「MSIX 只能降级」这句文档会悄悄过期成假绿。
 *
 * 用法：node scripts/diag-msix.mjs
 * 未装商店版 → SKIP（退出 0，不判红：断环境不是断产品）。
 * 退出码：0 结论成立 / 1 出现新激活入口需实现 / 2 探针自身出错。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { _internal } from '../lib/index.js';

const PS = join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT = [
  "$p = Get-AppxPackage -Name '*RestNow*' | Select-Object -First 1;",
  "if (-not $p) { 'NO_PACKAGE' } else {",
  "  $m = Join-Path $p.InstallLocation 'AppxManifest.xml';",
  "  if (-not (Test-Path $m)) { 'NO_MANIFEST' } else {",
  "    'PKG=' + $p.PackageFullName;",
  "    'DIR=' + $p.InstallLocation;",
  "    '---MANIFEST---';",
  "    Get-Content -Path $m -Raw -Encoding UTF8;",
  "  }",
  '}',
].join(' ');

const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
if (r.error) {
  console.error('探针自身出错：', String(r.error));
  process.exit(2);
}
const out = String(r.stdout || '');
if (out.includes('NO_PACKAGE')) {
  console.log('SKIP：本机没装商店 MSIX 版，无法查证清单（不判红）。');
  process.exit(0);
}
if (out.includes('NO_MANIFEST') || !out.includes('---MANIFEST---')) {
  console.error('探针自身出错：找不到 AppxManifest.xml\n' + (r.stderr || out).slice(0, 800));
  process.exit(2);
}
const meta = out.slice(0, out.indexOf('---MANIFEST---'));
const xml = out.slice(out.indexOf('---MANIFEST---') + 14);
// 只看 XML 标签，不看注释：清单里中文说明文字提到别名/协议是合法的。
const tags = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
const hasAlias = /AppExecutionAlias|<uap5?:AppExecutionAlias/i.test(tags);
const hasProtocol = /<uap5?:Protocol|<uap:Protocol|<Protocol\s/i.test(tags);
const hasStartupTask = /windows\.startupTask/i.test(tags);
const fullTrust = /Windows\.FullTrustApplication/.test(tags);
const appId = (meta.match(/PKG=(.+)/) || [])[1]?.trim() || '';

const results = [];
const ck = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail });
ck('读到 MSIX 包标识', Boolean(appId), appId);
ck('应用是 Windows.FullTrustApplication（桌面桥）', fullTrust);
ck('★ 清单里没有 AppExecutionAlias（有就能直接带 --startup 启动）', !hasAlias, `hasAlias=${hasAlias}`);
ck('★ 清单里没有 uap:Protocol（有就能用 URL 激活传参）', !hasProtocol, `hasProtocol=${hasProtocol}`);
ck('清单里确有 StartupTask，但它只由系统开机触发、外部进程无法激活', hasStartupTask);
const cmd = _internal.buildLaunchCommand(
  { kind: 'appid', target: 'RestNow.RestNow_xx3gqf7f82d0w!RestNow' },
  { tomatoOnly: true },
);
// ★ 判语义不判手段：appid 这一路的 args 本来就有 `shell:AppsFolder\...`，
//   写「args 为空」是错的断言；真正要守的是「没把 --startup 混进去」+ 如实降级。
ck('★ buildLaunchCommand(appid) 仍如实降级（degraded=true 且不带 --startup）',
  Boolean(cmd) && cmd.degraded === true && cmd.tomatoOnly === false
  && !cmd.args.includes(_internal.STARTUP_ARG),
  cmd);

for (const x of results) {
  console.log((x.ok ? '  OK   ' : '  FAIL ') + x.label + (x.detail && !x.ok ? `  << ${JSON.stringify(x.detail)}` : ''));
}
const bad = results.filter((x) => !x.ok).length;
console.log(`\nMSIX 激活入口查证：PASS=${results.length - bad} FAIL=${bad}`);
console.log('结论：外部插件无法给商店版传 --startup；只能降级为普通启动并明确提示。');
if (hasAlias || hasProtocol) {
  console.log('⚠️ 出现新的可传参激活入口 —— 回来实现，别让「只能降级」变成过期结论。');
}
process.exit(bad ? 1 : 0);
