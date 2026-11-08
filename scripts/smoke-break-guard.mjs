// 回归：取消「右下角小卡」后大肥鱼必须回原位（2026-11-07 反馈 #3，1.4.5）
//
//   复刻用户现象（真机 harness.log 07:15:16）：
//     rest.shown  fullscreen:false  rect 510x213 @ (2014,1297)  → 鱼坐到 (0.8863, 0.6956)
//     用户点「取消」/×/Esc                                      → 之后 49 秒没有 break ended
//     下一轮 rest.shown 才靠「dismiss 疑似丢失」自愈重新落座     → 鱼一直没回家
//
//   真因（产品侧 restnow_bridge_host.py / health_reminder.py，本插件不改产品）：
//     · rest.dismissed 只在 App._dismiss_popup()（锁屏/解锁/息屏静音）里广播；
//       手动关小卡走 ReminderPopup.close() → _destroy() → App._popup_closed()，不广播。
//     · 窗口观察器只认「TkTopLevel 面积 ≥ 55% 屏幕」的全屏弹窗，小卡永远不触发
//       active=true，也就不会有 active=false 的兜底归位。
//     ⇒ breakActive 卡 true、seat.at 不清空。
//
//   本测试只驱动 Engine（不依赖真实歇会儿 / 桌宠 / 窗口）。
//   sitBeside / restore 是 fire-and-forget，触发后等一拍再断言。
//   ★ 最后一组是「正控」：关掉兜底后同一场景必须复现 bug，证明前面的绿不是恒绿。
import { _internal } from '../lib/index.js';

const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const SCREEN = { w: 2560, h: 1600, workTop: 0, workH: 1528 };
// 右下角小卡：产品侧 _geo() 量得 popup 有矩形、popup_card 为 null
const SMALL_CARD = { x: 2014, y: 1297, w: 510, h: 213 };
const GEO_OPEN = {
  screen: SCREEN,
  popup: SMALL_CARD,
  popup_card: null,
  tomato: { x: 120, y: 120, w: 200, h: 200 },
};
// 用户关掉小卡后：_popup_closed() 把 app._popup 置 None ⇒ 下一份 geo 里两项皆 null
const GEO_GONE = { screen: SCREEN, popup: null, popup_card: null, tomato: null };
const GEO_UNTRUSTED = { popup: null, popup_card: null };   // 没量到 screen，不可信
const HOME = { x: 0.85, y: 0.12 };

function makeEngine(over = {}, snapshot = GEO_GONE) {
  const eng = new _internal.Engine({
    accompany: true, accompanyMode: 'spring', accompanyGap: 10, petTitle: 'dsh-pet',
    ...over,
  });
  eng.act = async () => {};                 // 隔离动作广播
  const moves = [];
  eng.pet = {
    move: async (x, y) => { moves.push({ x, y }); return true; },
    meta: () => ({ size: 462, position: HOME, memes: [], known: true }),
    livePos: async () => ({ ...HOME }),
    say: async () => true,
    snapshot: () => ({}),
  };
  eng.bridge = {
    snapshotDeep: async () => snapshot,
    snapshot: () => ({ available: true, connected: true }),
  };
  eng.muted = false;
  eng._moves = moves;
  return eng;
}

const wentHome = (e) => e._moves.some((m) => Math.abs(m.x - HOME.x) < 1e-3);
const smallBreak = (e) => e.onBreak(true, {
  source: 'bridge', geo: GEO_OPEN, rect: SMALL_CARD, fullscreen: false, duration: 20,
});
// 跳过「刚 shown 的宽限期」，等价于用户开着小卡待了几秒才点取消
const age = (e) => { e.lastBreakStartAt = Date.now() - 5000; };

(async () => {
  /* ---- 1. 主路径：只有 snapshot 说「弹窗没了」，两票后归位 ---- */
  let e = makeEngine();
  smallBreak(e);
  await tick();
  ck('前置：小卡弹出后鱼确实离开了家（坐到右下角）', !!(e.seat.at) && e._moves.length >= 1);
  age(e);
  const vote1 = e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  ck('几何推断：单票不归位（防一次探测抖动）', vote1 === false && e.breakActive === true);
  await tick(950);
  const vote2 = e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  await tick();
  ck('★ 小卡取消但无 rest.dismissed → 第二票兜底归位', vote2 === true);
  ck('★ 归位后 breakActive=false', e.breakActive === false);
  ck('★ 归位后 seat.at 清空', e.seat.at === null);
  ck('★ 鱼被移动回初始位置', wentHome(e));
  ck('兜底计数 +1（可观测）', e.stats.breakPopupGuard === 1);

  /* ---- 2. 权威闭窗信号：timer.tick 的 popup_open=false 一票即归位 ---- */
  e = makeEngine();
  smallBreak(e);
  await tick();
  age(e);
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  await tick();
  ck('★ timer.tick(popup_open=false) 单票即归位', e.breakActive === false && wentHome(e));

  /* ---- 3. 弹窗仍在 → 绝不归位 ---- */
  e = makeEngine();
  smallBreak(e);
  await tick();
  age(e);
  e.observeBreakPopup({ geo: GEO_OPEN, popup_open: true }, 'snapshot');
  await tick(950);
  e.observeBreakPopup({ geo: GEO_OPEN, popup_open: true }, 'snapshot');
  await tick();
  ck('弹窗仍在：不误归位、鱼保持在座位上', e.breakActive === true && !!(e.seat.at) && !wentHome(e));

  e = makeEngine();
  smallBreak(e); await tick(); age(e);
  // 权威布尔说「开着」但几何一次没量到 —— 不能以几何为准把鱼送回家
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: true, geo: GEO_GONE } });
  e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  await tick();
  ck('popup_open=true 与 geo.popup=null 冲突时以权威布尔为准', e.breakActive === true && !wentHome(e));

  /* ---- 4. 一票之后弹窗又出现 → 判定撤销，不能靠累积票归位 ---- */
  e = makeEngine();
  smallBreak(e);
  await tick();
  age(e);
  e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  e.observeBreakPopup({ geo: GEO_OPEN }, 'snapshot');       // 中间来了一帧「还在」
  e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  await tick();
  ck('中间观测到弹窗仍在 → 票数清零，不累积误判', e.breakActive === true && e.breakGuardStreak === 1);

  /* ---- 5. 几何不可信 / 宽限期 / 开关 / 静音 / 非休息态 ---- */
  e = makeEngine();
  smallBreak(e); await tick(); age(e);
  e.observeBreakPopup({ geo: GEO_UNTRUSTED }, 'snapshot');
  e.observeBreakPopup({ geo: GEO_UNTRUSTED }, 'snapshot');
  await tick();
  ck('geo 缺 screen ⇒ 不可信，不归位', e.breakActive === true && e.breakGuardStreak === 0);

  e = makeEngine();
  smallBreak(e); await tick();           // 不 age：还在 1.2s 宽限期内
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  await tick();
  ck('刚 shown 的宽限期内不归位（建窗瞬间量不到矩形）', e.breakActive === true);
  e.onBreak(false, { source: 'cleanup' });

  e = makeEngine({ breakPopupGuard: false });
  smallBreak(e); await tick(); age(e);
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  await tick();
  ck('breakPopupGuard=false 时维持旧行为（不归位）', e.breakActive === true);

  e = makeEngine();
  smallBreak(e); await tick(); age(e);
  e.muted = true;
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  await tick();
  ck('静音时不驱动桌宠、也不归位', e.breakActive === true);
  e.muted = false;

  e = makeEngine();
  age(e);
  const before = e._moves.length;
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  await tick();
  ck('不在休息态：兜底不动鱼', e.breakActive === false && e._moves.length === before);

  /* ---- 6. 与正常 dismiss 共存：幂等，不重复归位 ---- */
  e = makeEngine();
  smallBreak(e); await tick(); age(e);
  e.onBreak(false, { source: 'bridge', elapsed: 3 });      // 产品这次正常广播了
  const movesAfterDismiss = e._moves.length;
  e.onBridgeEvent({ kind: 'timer.tick', data: { popup_open: false, geo: GEO_GONE } });
  e.observeBreakPopup({ geo: GEO_GONE }, 'snapshot');
  await tick();
  ck('正常 dismiss 先到 → 兜底不再重复归位', e.stats.breakPopupGuard === 0 && e._moves.length === movesAfterDismiss);

  /* ---- 7. 真链路：poll() 拉 /v1/snapshot 驱动归位 ---- */
  e = makeEngine({}, GEO_GONE);
  smallBreak(e); await tick(); age(e);
  await e.poll();
  ck('poll() 第一票尚未归位', e.breakActive === true);
  await tick(950);
  await e.poll();
  await tick();
  ck('★ poll() 快路径（无需 rest.dismissed）能归位', e.breakActive === false && wentHome(e));
  ck('poll() 走的确实是兜底路径', e.stats.breakPopupGuard === 1);

  /* ---- 8. 诊断入口：/restnow break-gone ---- */
  e = makeEngine();
  smallBreak(e); await tick();
  const ok = e.simulate('break-gone');
  await tick();
  ck('simulate(break-gone) 强制走兜底路径并归位', ok === true && e.breakActive === false && wentHome(e));

  /* ---- 9. 正控：关掉兜底后必须复现「鱼不回家」，证明上面的绿不是恒绿 ---- */
  e = makeEngine({ breakPopupGuard: false }, GEO_GONE);
  smallBreak(e); await tick(); age(e);
  await e.poll(); await tick(950); await e.poll(); await tick();
  ck('★ 正控：旧行为下小卡取消后鱼仍不回家（bug 可复现）',
    e.breakActive === true && !!(e.seat.at) && !wentHome(e) && e.stats.breakPopupGuard === 0);

  /* ---- 结果 ---- */
  const fail = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label
      + (r.ok || r.detail === undefined ? '' : `  << ${JSON.stringify(r.detail)}`));
  }
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length}  (small-card dismiss guard)`);
  process.exit(fail.length ? 1 : 0);
})();
