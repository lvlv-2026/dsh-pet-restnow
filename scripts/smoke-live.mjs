// 真机联调：把插件连到**正在运行的歇会儿**，验证事件流与反向动作。
// 跑法：node scripts/smoke-live.mjs "C:/path/to/bridge.json"
//
// 与 smoke-bridge.mjs 的区别：那个用假服务，这个用真歇会儿（会真的改提醒时间）。
import { readFileSync } from 'node:fs';

import { apply, name } from '../lib/index.js';

const bridgeFile = process.argv[2];
if (!bridgeFile) {
  console.error('用法：node scripts/smoke-live.mjs <bridge.json 路径>');
  process.exit(2);
}
process.env.DSH_RESTNOW_BRIDGE = bridgeFile;

const desc = JSON.parse(readFileSync(bridgeFile, 'utf8'));
const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const disposers = [];
const ctx = {
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
  },
  commands: {
    register() {
      return () => {};
    },
  },
  provide() {},
  get() {
    return null;
  },
};

const PORT = 47197;
apply(ctx, { bridgePort: PORT, bridgeFile, watchWindows: false, pollMs: 60000 });
await wait(3000);

const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) =>
  (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

let st = await get('/status');
ck('插件识别到桌面桌宠', st.pet && st.pet.port > 0, JSON.stringify(st.pet));
ck('进入桥接模式', st.bridgeMode === true, JSON.stringify(st.bridge));
ck('SSE 已连接', st.bridge && st.bridge.connected === true);
ck('读到歇会儿版本', !!(st.bridge && st.bridge.appVersion), JSON.stringify(st.bridge.appVersion));

// 反向：延后 5 分钟
const r1 = await post('/action', { type: 'snooze', args: { minutes: 5, reason: '真机联调' } });
ck('snooze 真歇会儿返回 next_at', r1 && r1.ok && !!r1.next_at, JSON.stringify(r1));

// 反向：暂停 → 恢复
const r2 = await post('/action', { type: 'toggle_pause', args: {} });
ck('toggle_pause 生效', r2 && r2.ok && typeof r2.paused === 'boolean', JSON.stringify(r2));
const r3 = await post('/action', { type: 'toggle_pause', args: {} });
ck('再次 toggle 复位', r3 && r3.ok, JSON.stringify(r3));

// 反向：立即休息 → 立刻收窗（会真的弹一下）
const r4 = await post('/action', { type: 'rest_now', args: {} });
ck('rest_now 被受理', r4 && r4.ok, JSON.stringify(r4));
await wait(1500);
st = await get('/status');
ck('弹窗事件已进来', st.breakActive === true, JSON.stringify({ breakActive: st.breakActive }));
const r5 = await post('/action', { type: 'ack_rest', args: {} });
ck('ack_rest 收窗', r5 && r5.ok, JSON.stringify(r5));
await wait(1200);
st = await get('/status');
ck('收窗后复位', st.breakActive === false);

/* ---- 陪工位：真弹窗 + 真桌宠（会真的把桌宠挪一下，结束后自动归位）---- */
const cfgPath = (st.restnow && st.restnow.configPath) || '';
let origFullscreen = null;
try {
  origFullscreen = JSON.parse(readFileSync(cfgPath, 'utf8')).fullscreen_popup;
} catch {
  /* 读不到就按 false 处理 */
}
// 全屏弹窗铺满整屏，没有「旁边」可陪 —— 换成右下角小卡才有避让空间
await post('/action', { type: 'set_config', args: { patch: { fullscreen_popup: false } } });
await wait(400);
const r6 = await post('/action', { type: 'rest_now', args: {} });
ck('小卡弹窗被受理', r6 && r6.ok, JSON.stringify(r6));
await wait(1800);
st = await get('/status');
const geo = st.geo || {};
const pop = geo.popup || {};
const seat = st.seat && st.seat.at;
ck('陪工位：拿到真实弹窗矩形', pop.w > 100 && pop.h > 60, JSON.stringify(pop));
ck('陪工位：桌宠已挪位', Boolean(seat), JSON.stringify(st.seat));
if (seat && pop.w) {
  const size = (st.pet && st.pet.size) || 462;
  const sc = geo.screen || {};
  const box = {
    x: seat.x * sc.w - (size * 0.502) / 2,
    y: seat.y * sc.workH + size * 0.169 - (size * 0.632) / 2,
    w: Math.round(size * 0.502),
    h: Math.round(size * 0.632),
  };
  const hit = !(box.x + box.w <= pop.x || box.x >= pop.x + pop.w
    || box.y + box.h <= pop.y || box.y >= pop.y + pop.h);
  ck('陪工位：落点不压弹窗', !hit, JSON.stringify({ box, pop }));
} else {
  ck('陪工位：落点不压弹窗', false, 'no seat');
}
await post('/action', { type: 'ack_rest', args: {} });
await wait(1200);
st = await get('/status');
ck('陪工位：收窗后归位', !(st.seat && st.seat.at), JSON.stringify(st.seat));
if (origFullscreen) {
  await post('/action', { type: 'set_config', args: { patch: { fullscreen_popup: true } } });
}

for (const d of disposers) {
  try {
    d();
  } catch {
    /* ignore */
  }
}
await wait(300);

const failed = results.filter((x) => !x.ok);
for (const x of results) console.log((x.ok ? '  OK   ' : '  FAIL ') + x.label + (x.detail && !x.ok ? `  << ${x.detail}` : ''));
console.log(`PASS=${results.length - failed.length} FAIL=${failed.length}  (plugin=${name}, restnow=${desc.appVersion || '?'})`);
process.exit(failed.length ? 1 : 0);
