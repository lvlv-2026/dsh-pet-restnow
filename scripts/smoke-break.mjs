// 回归：休息「落座 / 归位」的健壮性（修复 2026-11-07 反馈 #1 #2）
//
//   复刻用户现象：
//   ① 只有第一次立即休息鱼会动，之后都不动
//      → 根因：旧逻辑用 `active === breakActive` 去重，一旦某次 rest.dismissed 被漏掉
//        （SSE 丢包 / 桥重连瞬间关窗），breakActive 永久卡 true，后续所有落座都被吃掉。
//   ② 解除弹窗后鱼没回原位
//      → 同上，dismiss 没到 → 永远不归位。
//
//   本测试直接驱动 Engine.onBreak（不依赖真实歇会儿 / 桌宠 / 窗口）。注意 onBreak 内部
//   的 sitBeside/restore 是 fire-and-forget，故每次触发后等一拍让异步落座/归位完成再断言。
import { _internal } from '../lib/index.js';

const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const GEO = {
  screen: { w: 2560, h: 1600, workTop: 0, workH: 1528 },
  popup_card: { x: 1000, y: 600, w: 520, h: 300 },
  popup: { x: 0, y: 0, w: 2560, h: 1600 },
  tomato: { x: 120, y: 120, w: 200, h: 200 },
};
const HOME = { x: 0.85, y: 0.12 };

function makeEngine() {
  const eng = new _internal.Engine({
    accompany: true, accompanyMode: 'spring', accompanyGap: 10, petTitle: 'dsh-pet',
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
  eng.bridge = { snapshotDeep: async () => GEO, snapshot: () => ({ available: true }) };
  eng.muted = false;
  eng._moves = moves;
  return eng;
}

const shown = (g = GEO) => ({ source: 'bridge', geo: g, rect: g.popup_card });
const dismissed = (g = GEO) => ({ source: 'bridge', geo: g });

(async () => {
  /* ---- 1. 正常一轮：shown→落座，dismissed→归位 ---- */
  let e = makeEngine();
  e.onBreak(true, shown());
  await tick();
  ck('shown 后 breakActive=true', e.breakActive === true);
  ck('shown 后已落座 (seat.at 有值)', !!(e.seat.at && e.seat.at.x !== undefined));
  ck('shown 后鱼被移动到目标旁', e._moves.length >= 1);
  e.onBreak(false, dismissed());
  await tick();
  ck('dismissed 后 breakActive=false', e.breakActive === false);
  ck('dismissed 后已归位 (seat.at 清空)', e.seat.at === null);
  ck('dismissed 后鱼被移动回家', e._moves.some((m) => Math.abs(m.x - HOME.x) < 1e-3));

  /* ---- 2. 自愈：dismiss 丢失，再来一次 shown 应重新落座（且不跳回家再拉回）---- */
  e = makeEngine();
  e.onBreak(true, shown());
  await tick();
  const movesAfterFirst = e._moves.length;
  // 模拟 dismiss 永远没来：直接再来一次 shown（并伪造「上次开始在 5 秒前」）
  e.lastBreakStartAt = Date.now() - 5000;
  e.onBreak(true, shown());
  await tick(200);
  ck('自愈：第二次 shown 仍 breakActive=true', e.breakActive === true);
  ck('自愈：第二次 shown 后依然落座', !!(e.seat.at && e.seat.at.x !== undefined));
  // ★ 1.4.2：自愈不再「先送回家再拉回」（那才是肉眼可见的跳/闪）。
  //   鱼若本来就坐在卡片旁，自愈后保持原位、不再产生额外移动。
  ck('自愈：已就座则不重复挪动（不闪、不跳）', e._moves.length === movesAfterFirst);
  e.onBreak(false, dismissed());
  await tick();
  ck('自愈后 dismiss 能正常归位', e.seat.at === null && e.breakActive === false);

  /* ---- 3. 重复广播：2 秒内的重复 shown 应被跳过（鱼不乱跳）---- */
  e = makeEngine();
  e.onBreak(true, shown());
  await tick();
  const m1 = e._moves.length;
  e.lastBreakStartAt = Date.now();         // 与上一次开始 < 2s
  e.onBreak(true, shown());
  await tick();
  ck('2 秒内重复 shown 被跳过（不再移动）', e._moves.length === m1);
  e.onBreak(false, dismissed());
  await tick();

  /* ---- 4. 乱序：没有 shown 就收到 dismissed → 忽略 ---- */
  e = makeEngine();
  const before = e._moves.length;
  e.onBreak(false, dismissed());
  await tick();
  ck('无对应 shown 的 dismissed 被忽略', e.breakActive === false && e._moves.length === before);

  /* ---- 5. 窗口观察器兜底：raiseOnly 模式下 active=false 必须放行归位 ---- */
  e = makeEngine();
  e.onBreak(true, shown());
  await tick();
  e.onBreak(false, { source: 'window' });  // 模拟桥模式下窗口观察器报告弹窗已关
  await tick();
  ck('窗口观察器 active=false 兜底能归位', e.seat.at === null && e.breakActive === false);

  /* ---- 6. 冗余落座去重：fish 已坐在同一目标旁，再来一次 shown 不应重复挪动（防闪）---- */
  e = makeEngine();
  e.onBreak(true, shown());
  await tick();
  const m6 = e._moves.length;
  // 模拟 SSE 重连补发 / 抖动：再来一次 shown，目标矩形一模一样，且距上次 >2s 触发自愈分支
  e.lastBreakStartAt = Date.now() - 5000;
  e.onBreak(true, shown());
  await tick(200);
  ck('冗余 shown：已就座则跳过重复挪动（不闪）', e._moves.length === m6);
  ck('冗余 shown：鱼仍稳稳落在原位', !!(e.seat.at && e.seat.at.x !== undefined));
  e.onBreak(false, dismissed());
  await tick();

  /* ---- 结果 ---- */
  const fail = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label
      + (r.ok || r.detail === undefined ? '' : `  << ${JSON.stringify(r.detail)}`));
  }
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length}  (break seat/restore self-heal)`);
  process.exit(fail.length ? 1 : 0);
})();
