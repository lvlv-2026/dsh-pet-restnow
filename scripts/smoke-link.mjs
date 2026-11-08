// 链路稳固性回归：地址推导 / 换端口 / 动作重试 / 心跳半死 / 桌宠重发现。
//
// 跑法：node scripts/smoke-link.mjs
//
// 这一组针对的是「日志一切正常，鱼就是不动」那一类最难查的故障 ——
// 连接看起来还在，其实早就连到一个死地址上了。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _internal } from '../lib/index.js';

const { Engine } = _internal;

const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SCREEN = { w: 2560, h: 1600, workTop: 0, workH: 1528 };

/* ---------------- 假桥工厂 ---------------- */

/**
 * @param {object} opts
 *   token       当前有效 token
 *   health      'ok' | 'hang'（不答复，让客户端超时）| 'down'（直接断）
 *   silentEvents true 时不发任何事件（模拟「连着但没动静」）
 */
async function startBridge(opts = {}) {
  const st = {
    token: opts.token || 'tok-1',
    health: opts.health || 'ok',
    seq: opts.seq || 0,
    actions: [],
    sse: new Set(),
    hits: { health: 0, events: 0, action: 0, snapshot: 0 },
    silent: Boolean(opts.silentEvents),
  };
  const srv = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const send = (code, o) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/v1/health') {
      st.hits.health += 1;
      if (st.health === 'hang') return undefined;          // 不答复 ⇒ 客户端 1200ms 后超时
      if (st.health === 'down') {
        res.destroy();
        return undefined;
      }
      return send(200, { ok: true, pid: process.pid, appVersion: '1.0.9.0-fake' });
    }
    if (auth !== 'Bearer ' + st.token) return send(401, { ok: false, error: 'unauthorized' });
    if (url.pathname === '/v1/snapshot') {
      st.hits.snapshot += 1;
      return send(200, {
        ok: true, v: 1, app: 'RestNow', appVersion: '1.0.9.0-fake',
        pid: process.pid, port: srv.address().port, seq: st.seq, screen: SCREEN,
      });
    }
    if (url.pathname === '/v1/events') {
      st.hits.events += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      st.sse.add(res);
      req.on('close', () => st.sse.delete(res));
      return undefined;
    }
    if (url.pathname === '/v1/action') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        st.hits.action += 1;
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        st.actions.push(parsed);
        send(200, { ok: true, applied: true, next_at: '2026-11-07T12:00:00+08:00' });
      });
      return undefined;
    }
    return send(404, { ok: false, error: 'not-found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.port = srv.address().port;
  st.close = () => new Promise((r) => {
    for (const res of st.sse) {
      try { res.destroy(); } catch { /* ignore */ }
    }
    st.sse.clear();
    srv.close(() => r());
  });
  return st;
}

function writeDescriptor(path, port, token, pid) {
  writeFileSync(path, JSON.stringify({
    v: 1, port, token, pid: pid || process.pid,
    startedAt: Date.now() / 1000, appVersion: '1.0.9.0-fake',
  }));
}

/* ================================================================== *
 * A. 地址是**推导**出来的：只给 config.json，不给 bridge.json 的路径
 * ================================================================== */
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-link-'));
  const dataDir = join(dir, 'RestNowData');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    interval_minutes: 45, popup_duration_seconds: 10, stat_count: 0, pomo_log: [],
  }));
  const b = await startBridge({ token: 'tok-derive' });
  writeDescriptor(join(dataDir, 'bridge.json'), b.port, 'tok-derive');

  const eng = new Engine({
    configPath: join(dataDir, 'config.json'),
    useBridge: true, watchWindows: false, pollMs: 60000, petPort: 1,
  });
  const ok = await eng.bridge.probe();
  ck('只给 config.json 也能推导出 bridge.json', ok, JSON.stringify(eng.bridge.snapshot()));
  ck('推导出来的路径就是同目录那份',
    eng.bridge.descriptor === join(dataDir, 'bridge.json'), eng.bridge.descriptor);
  ck('数据目录（configDir）已识别', eng.bridge.configDir() === dataDir, eng.bridge.configDir());
  await b.close();
}

/* ================================================================== *
 * B. 歇会儿重启换端口 ⇒ 自动换到新地址并重连
 * ================================================================== */
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-link-'));
  const dataDir = join(dir, 'RestNowData');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pomo_log: [] }));
  const descPath = join(dataDir, 'bridge.json');

  const b1 = await startBridge({ token: 'tok-A' });
  writeDescriptor(descPath, b1.port, 'tok-A');
  const eng = new Engine({
    configPath: join(dataDir, 'config.json'),
    useBridge: true, watchWindows: false, pollMs: 60000, petPort: 1,
    heartbeatIdleMs: 600000,   // 这一段不需要心跳
  });
  await eng.bridge.probe();
  eng.bridge.start();
  await wait(700);
  ck('B 初始连上旧端口', eng.bridge.connected === true && eng.bridge.port === b1.port,
    JSON.stringify({ port: eng.bridge.port, old: b1.port }));

  // 歇会儿「重启」：旧端口没了，新端口 + 新 token，描述文件被重写
  await b1.close();
  const b2 = await startBridge({ token: 'tok-B' });
  writeDescriptor(descPath, b2.port, 'tok-B');

  const ok = await eng.bridge.probe();
  ck('B 重探能发现新端口', ok && eng.bridge.port === b2.port,
    JSON.stringify({ port: eng.bridge.port, want: b2.port }));

  let moved = false;
  for (let i = 0; i < 20; i += 1) {
    await wait(200);
    if (eng.bridge.connected && b2.hits.events > 0) { moved = true; break; }
  }
  ck('B SSE 自动重连到新端口（不用重启 DSH）', moved,
    JSON.stringify({ connected: eng.bridge.connected, events: b2.hits.events, old: b1.hits.events }));
  eng.bridge.stop();
  await b2.close();
}

/* ================================================================== *
 * C. 动作发到旧端口 ⇒ 自动重探再重试一次
 * ================================================================== */
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-link-'));
  const dataDir = join(dir, 'RestNowData');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pomo_log: [] }));
  const descPath = join(dataDir, 'bridge.json');

  const b1 = await startBridge({ token: 'tok-C1' });
  writeDescriptor(descPath, b1.port, 'tok-C1');
  const eng = new Engine({
    configPath: join(dataDir, 'config.json'),
    useBridge: true, watchWindows: false, pollMs: 60000, petPort: 1,
  });
  await eng.bridge.probe();
  ck('C 初始探到旧端口', eng.bridge.port === b1.port, `port=${eng.bridge.port}`);

  await b1.close();                       // 旧进程没了：动作会打到一个死端口
  const b2 = await startBridge({ token: 'tok-C2' });
  writeDescriptor(descPath, b2.port, 'tok-C2');

  const r = await eng.bridge.action('snooze', { minutes: 15 });
  ck('C 旧端口失败后自动重探并重试成功', r && r.ok, JSON.stringify(r));
  ck('C 重试打到的是新端口', b2.hits.action === 1 && b2.actions[0]
    && b2.actions[0].type === 'snooze', JSON.stringify(b2.actions));
  eng.bridge.stop();
  await b2.close();
}

/* ================================================================== *
 * D. SSE 半死（连着但收不到数据、health 也不应答）⇒ 心跳判定后重连
 * ================================================================== */
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-link-'));
  const dataDir = join(dir, 'RestNowData');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pomo_log: [] }));

  const b = await startBridge({ token: 'tok-D', silentEvents: true, health: 'ok' });
  writeDescriptor(join(dataDir, 'bridge.json'), b.port, 'tok-D');

  const eng = new Engine({
    configPath: join(dataDir, 'config.json'),
    useBridge: true, watchWindows: false, pollMs: 60000, petPort: 1,
    heartbeatIdleMs: 400, heartbeatTickMs: 150,
  });
  await eng.bridge.probe();
  eng.bridge.start();
  await wait(600);
  const reconnects0 = eng.bridge.stats.reconnects;
  ck('D 先正常连上', eng.bridge.connected === true, JSON.stringify(eng.bridge.snapshot()));

  // health 开始不应答：客户端应该判定「半死」并主动断开重连
  b.health = 'hang';
  let flipped = false;
  for (let i = 0; i < 40; i += 1) {
    await wait(200);
    if (eng.bridge.stats.reconnects > reconnects0) { flipped = true; break; }
  }
  ck('D 心跳发现半死并主动重连', flipped,
    JSON.stringify({ reconnects: eng.bridge.stats.reconnects, before: reconnects0, hits: b.hits }));

  // 恢复健康：应该能重新连上，而不是一直卡在重连里
  b.health = 'ok';
  let back = false;
  for (let i = 0; i < 40; i += 1) {
    await wait(200);
    if (eng.bridge.connected) { back = true; break; }
  }
  ck('D 恢复后自动连回来', back, JSON.stringify(eng.bridge.snapshot()));
  eng.bridge.stop();
  await b.close();
}

/* ================================================================== *
 * E. 桌宠端口变了 ⇒ 动作失败自动重发现 + 重试
 * ================================================================== */
{
  const mkPet = (name) => {
    const s = { name, moves: [], hits: 0 };
    s.srv = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const send = (o) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (url.pathname.endsWith('/config')) {
        return send({ main: { pets: [{ id: 'main', size: 420 }], memes: { 可爱: '' } } });
      }
      if (url.pathname.endsWith('/state')) {
        return send({ pets: { main: { position: { data: { x: 0.9, y: 0.1 } } } } });
      }
      if (url.pathname.endsWith('/position')) {
        s.hits += 1;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          s.moves.push(JSON.parse(body || '{}'));
          send({ ok: true });
        });
        return undefined;
      }
      return send({ ok: true });
    });
    return s;
  };
  const petA = mkPet('A');
  await new Promise((r) => petA.srv.listen(0, '127.0.0.1', r));
  const portA = petA.srv.address().port;

  const petB = mkPet('B');
  await new Promise((r) => petB.srv.listen(0, '127.0.0.1', r));
  const portB = petB.srv.address().port;

  // 候选端口 = cfg.petPort（旧） + 动态提示（新）
  const eng = new Engine({
    bridgeFile: join(tmpdir(), 'no-such-bridge.json'),
    useBridge: false, watchWindows: false, pollMs: 60000,
    petPort: portA, petId: 'main', petHintPort: () => portB,
  });
  const foundA = await eng.pet.discover();
  ck('E 先连上桌宠 A', foundA && eng.pet.port === portA, `port=${eng.pet.port}`);

  // 桌宠「重启」：A 没了，B 在另一个端口
  await new Promise((r) => petA.srv.close(r));
  const okMove = await eng.pet.move(0.5, 0.5, { mode: 'instant' });
  ck('E 旧端口失败后自动重发现并重试', okMove, JSON.stringify(eng.pet.snapshot()));
  ck('E 打到的是新端口的桌宠', petB.hits === 1 && Math.abs(petB.moves[0].x - 0.5) < 1e-6,
    JSON.stringify(petB.moves));
  await new Promise((r) => petB.srv.close(r));
}

/* ---------------- 结果 ---------------- */
const fail = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? '  OK   ' : '  FAIL ') + r.label
    + (r.ok || r.detail === undefined ? '' : `  << ${r.detail}`));
}
console.log(`PASS=${results.length - fail.length} FAIL=${fail.length}  (link stability)`);
process.exit(fail.length ? 1 : 0);
