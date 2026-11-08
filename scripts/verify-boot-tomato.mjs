// 真机端到端：点「开始专注 35min」而歇会儿没开 → 自动拉起 → 只出番茄钟 → 状态=35min。
// ★ 会真的启动一次歇会儿 GUI（约 10~20 秒），默认验完用桥动作 quit 收掉；
//   想留着看效果加 --keep。已经开着歇会儿时直接拒绝跑，避免误关用户正在用的实例。
// ★ 一律调产品真函数（Engine.petAction），不复制启动逻辑，避免「探针绿、真机红」。
import { spawnSync } from 'node:child_process';
import { _internal } from '../lib/index.js';

const { Engine, DEFAULTS, findPwsh } = _internal;
const KEEP = process.argv.includes('--keep');
const MINUTES = 35;

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

/** 用 PowerShell 读主窗口标题：主界面亮着时它正好叫「歇会儿」。 */
function mainWindowTitle() {
  const code = "$p = @(Get-Process | Where-Object { $_.ProcessName -match 'RestNow|HealthReminder' });"
    + "($p | ForEach-Object { $_.MainWindowTitle }) -join '|'";
  const r = spawnSync(findPwsh(), ['-NoProfile', '-NonInteractive', '-Command', code],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return String(r.stdout || '').trim();
}

const before = mainWindowTitle();
if (before && /歇会儿|RestNow/.test(before)) {
  console.log(`\n跳过：歇会儿已经在运行（主窗标题「${before}」），本探针需要独占启动。`);
  console.log('请先退出歇会儿再跑，或改用 node scripts/run-all.mjs 做无副作用回归。');
  process.exit(2);
}

const cfg = {
  ...DEFAULTS,
  watchWindows: false,      // 别起 PowerShell 窗口观察器
  enablePetMenu: false,     // 别抢桌宠菜单轮询
  announceBreak: false,
  launchTomatoOnly: true,
  launchSettleMs: 450,
  autoLaunchRestNow: true,
};
const engine = new Engine(cfg);
let r = null;
let geo = null;
try {
  console.log('正在用产品真实链路启动歇会儿（--startup）…');
  r = await engine.petAction('start_focus', { minutes: MINUTES });
  ck('★ 动作最终成功', Boolean(r && r.ok === true), r);
  ck('★ 确实拉起了新进程', Boolean(r && r.launched === true), r);
  ck('★ 启动方式是「只出番茄钟」（tomatoOnly）', Boolean(r && r.tomatoOnly === true), r);
  ck('★ 不是商店版降级路径', Boolean(r && r.degraded === false), r);
  ck(`★ 回执分钟数 = ${MINUTES}（番茄钟倒计时按所点档位）`,
    Number(r && r.minutes) === MINUTES, { minutes: r && r.minutes, next_at: r && r.next_at });
  ck('★ 回执带 next_at（下次提醒被重排）', Boolean(r && r.next_at), r);

  const st = await engine.status(false);
  ck('★ 记录下来的 argv 含 --startup',
    Boolean(st.launchMode && st.launchMode.last && st.launchMode.last.args.includes('--startup')),
    st.launchMode);
  ck('★ 启动记录里带上原始动作 start_focus',
    Boolean(st.launchMode && st.launchMode.last && st.launchMode.last.action === 'start_focus'),
    st.launchMode);

  geo = await engine.geo(true);
  ck('★ 番茄钟真的在屏幕上（geo.tomato_probe.visible）',
    Boolean(geo && geo.tomato_probe && geo.tomato_probe.visible === true),
    geo && geo.tomato_probe);
  ck('★ 番茄钟有可见矩形（不是 1×1 未映射窗口）',
    Boolean(geo && geo.tomato && geo.tomato.w > 1 && geo.tomato.h > 1),
    geo && geo.tomato);
  ck('★ 没有额外弹出休息弹窗', geo && !geo.popup && !geo.popup_card,
    { popup: geo && geo.popup, card: geo && geo.popup_card });

  const title = mainWindowTitle();
  ck('★ 主界面没亮（进程主窗标题不是「歇会儿」）', !/歇会儿/.test(title), { title });

  if (!KEEP) {
    const q = await engine.bridge.action('quit', {});
    ck('收尾：通过桥动作退出刚拉起的实例', Boolean(q && q.ok === true), q);
  } else {
    console.log('  · --keep：保留刚启动的实例，请自行退出。');
  }
} catch (e) {
  fail += 1;
  console.log('  ✗ 探针异常', String(e && e.stack ? e.stack : e));
} finally {
  engine.stop();
}

console.log(`\n真机启动态验收：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
