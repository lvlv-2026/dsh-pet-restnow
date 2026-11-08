// 自愈回归：**先开 DSH，后开歇会儿**（或歇会儿重装/重启）时必须自己连上。
//
// 跑法：node scripts/smoke-recover.mjs
//
// 场景复刻（2026-11-07 真机踩到）：
//   ① 插件启动时 bridge.json 在，但端口没人听（歇会儿还没起来）
//      → probe() 失败 → 日志只有 `bridge not available`，停在窗口观察器模式；
//   ② 过一会儿歇会儿真的起来了，端口通了；
//   ③ 用户不动，插件应该**每 10 秒自己再探一次**，探到就切到事件流。
//
// 老实现只在 start() 里探一次，第 ③ 步永远不发生 —— 整个会话没有事件流、
// 没有反向控制，全屏遮罩还会把鱼压暗。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, _internal } from '../lib/index.js';

const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'recover-token';
const PET_SIZE = 420;

/* ---------- 假桌宠 ---------- */
const pet = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname.endsWith('/config')) {
    return send({ size: PET_SIZE, memes: { 可爱: '' }, petId: 'main' });
  }
  if (url.pathname.endsWith('/state')) {
    return send({ pets: { main: { position: { data: { x: 0.9, y: 0.1 } } } } });
  }
  if (url.pathname.endsWith('/position')) return send({ ok: true });
  return send({ ok: true });
});
await new Promise((r) => pet.listen(0, '127.0.0.1', r));
const petPort = pet.address().port;

/* ---------- 假桥（先不监听，模拟「歇会儿没起来」）---------- */
const bridgeSrv = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/v1/health') return send({ ok: true, pid: process.pid, appVersion: '1.0.9.0-fake' });
  if (url.pathname === '/v1/snapshot') {
    return send({ ok: true, v: 1, appVersion: '1.0.9.0-fake', seq: 0, screen: { w: 2560, h: 1600, workTop: 0, workH: 1528 } });
  }
  if (url.pathname === '/v1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    return undefined;
  }
  return send({ ok: true });
});
// 先占一个端口号再关掉，拿到一个「确定没人听」的端口
await new Promise((r) => bridgeSrv.listen(0, '127.0.0.1', r));
const bridgePortNum = bridgeSrv.address().port;
await new Promise((r) => bridgeSrv.close(r));

const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-recover-'));
const descPath = join(dir, 'bridge.json');
writeFileSync(descPath, JSON.stringify({
  v: 1, port: bridgePortNum, token: TOKEN, pid: process.pid,
  startedAt: Date.now() / 1000, appVersion: '1.0.9.0-fake',
}));

/* ---------- 起插件（此时桥是不通的）---------- */
apply({
  effect(fn) { const d = fn(); if (typeof d === 'function') void d; },
  commands: { register() { return () => {}; } },
  provide() {},
  get() { return null; },
}, {
  bridgePort: 47199, bridgeFile: descPath, watchWindows: false,
  pollMs: 600,                     // 自愈节拍是 10s，这里靠多次 poll 撞上
  petPort, petId: 'main',
});
await wait(2000);

const getJson = async (p) => (await fetch('http://127.0.0.1:47199' + p)).json();
let st = await getJson('/status');
ck('桥没起来时不进桥接模式', st.bridgeMode === false, JSON.stringify(st.bridge));
ck('退化成窗口观察器（不是崩了）', st.watcher !== undefined, JSON.stringify(Object.keys(st)));

/* ---------- 歇会儿起来了 ---------- */
await new Promise((r) => bridgeSrv.listen(bridgePortNum, '127.0.0.1', r));

// 自愈节拍 10 秒；pollMs 600ms ⇒ 大约 17 次 poll 内必然撞上
let recovered = false;
for (let i = 0; i < 40; i += 1) {
  await wait(500);
  st = await getJson('/status');
  if (st.bridgeMode === true) { recovered = true; break; }
}
ck('桥后来活了 → 自己切到事件流', recovered, JSON.stringify({ bridgeMode: st.bridgeMode, bridge: st.bridge }));
ck('切过去之后端口对得上', st.bridge && st.bridge.port === bridgePortNum,
  JSON.stringify(st.bridge));
ck('SSE 已连上', st.bridge && st.bridge.connected === true, JSON.stringify(st.bridge));

/* ---------- onBridgeUp 必须幂等 ---------- */
// 反复 poll 不能把 SSE 连成好几条，也不能把 watcher 反复重启。
await wait(2500);
st = await getJson('/status');
ck('反复自愈不重复连（幂等）', st.bridgeMode === true && st.bridge.connected === true,
  JSON.stringify(st.bridge));

/* ---------- Watcher 换模式重启的锁 ---------- */
// ★ 这是个真踩到的 bug：`stop()` 把 `stopped` 设成 true，而 `start()` 第一行
//   就是 `if (this.stopped) return` ⇒ stop 过的 watcher **永远起不来**。
//   以前 `onBridgeDown` 用 `stop()` + `setTimeout(start)` 切模式，等于什么都没干。
{
  const w = new _internal.WindowWatcher({ cfg: {}, bridge: {}, pet: {} });
  w.stopped = true;                     // 模拟 stop() 之后的状态
  let started = 0;
  w.start = async (raiseOnly) => { started += 1; w.raiseOnly = raiseOnly; };
  await w.restart(true);
  ck('restart 会解锁 stopped', w.stopped === false, `stopped=${w.stopped}`);
  ck('restart 真的重新调了 start', started === 1, `started=${started}`);
  ck('restart 带上目标模式', w.raiseOnly === true, `raiseOnly=${w.raiseOnly}`);
}

/* ---------- 结果 ---------- */
const fail = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label
    + (r.ok || r.detail === undefined ? '' : `  << ${r.detail}`));
}
console.log(`PASS=${results.length - fail.length} FAIL=${fail.length}  (bridge self-heal)`);
pet.close();
bridgeSrv.close();
process.exit(fail.length ? 1 : 0);
