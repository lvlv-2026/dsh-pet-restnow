// 桥接模式冒烟：起一个假的 restnow_bridge + 一个假桌宠，
// 验证插件「SSE 消费 / 反向动作 / 表情图 / 陪工位座位计算」四条链路。
// 跑法：node scripts/smoke-bridge.mjs
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply, name } from '../lib/index.js';
import { BridgeClient } from '../lib/bridge-client.js';

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const results = [];
const ck = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/* ---------------- 假桌宠（完全本地，不碰真实桌宠） ---------------- */
const PET_SIZE = 462;
const MEMES = {
  可爱: '标准正面卖萌立绘',
  死掉了: '翻肚皮躺平灵魂出窍',
  Ciallo: '比耶眨眼卖萌问候',
  厉害了我的鲸: '竖大拇指眨眼点赞',
  大的要来啦: '举喇叭大喊预警',
  哦鲸鲸: '死鱼眼说哦鲸鲸',
  就骚了怎么滴吧: '叉腰顶嘴',
  吃饱饱摸肚子: '吃饱了摸肚子，一脸满足',
};
const petCalls = { anim: [], say: [], move: [] };
// 假桌宠的**真实**归一化位置（/state 报的就是它）。
// 初值取「top-right + margin 24/100」的等价坐标：2560 宽、1600 高。
let fakePos = { x: 1 - 24 / 2560, y: 100 / 1600 };

const fakePet = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const readJson = (cb) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = null;
      try {
        j = JSON.parse(body || '{}');
      } catch {
        j = null;
      }
      cb(j);
    });
  };
  if (url.pathname.endsWith('/state')) {
    return send({ sections: {}, pets: { main: { position: { data: fakePos } } } });
  }
  if (url.pathname.endsWith('/config')) {
    return send({
      main: {
        memes: MEMES,
        pets: [{
          id: 'main', name: '大肥鱼', size: PET_SIZE, display: 'desktop',
          position: { corner: 'top-right', marginX: 24, marginY: 100 },
        }],
      },
    });
  }
  if (url.pathname.endsWith('/anim') && req.method === 'POST') {
    return readJson((b) => {
      petCalls.anim.push(b && b.name);
      send({ ok: true, playbackId: 'pb-' + petCalls.anim.length });
    });
  }
  if (url.pathname.endsWith('/broadcast') && req.method === 'POST') {
    return readJson((b) => {
      petCalls.say.push(b);
      send({ ok: true });
    });
  }
  if (url.pathname.endsWith('/position') && req.method === 'POST') {
    return readJson((b) => {
      petCalls.move.push(b);
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) fakePos = { x: b.x, y: b.y };
      send({ ok: true, x: b && b.x, y: b && b.y });
    });
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not-found' }));
});

/* ---------------- 假 bridge ---------------- */
const SSE_GEO = {
  screen: { w: 2560, h: 1600, workTop: 0, workH: 1528 },
  tomato: { x: 2200, y: 1300, w: 172, h: 198 },
  popup: { x: 2196, y: 1348, w: 340, h: 192 },
};

const sseClients = new Set();
const received = [];
let seq = 0;

function pushEvent(kind, data) {
  seq += 1;
  const payload = { v: 1, seq, ts: Date.now() / 1000, kind, data: data || {} };
  const chunk = `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(chunk);
    } catch {
      sseClients.delete(res);
    }
  }
  return payload;
}

const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization;
  if (url.pathname === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: fake.address().port, pid: process.pid, appVersion: '1.0.9.0-fake' }));
  }
  if (auth !== 'Bearer ' + TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }
  if (url.pathname === '/v1/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, v: 1, app: 'RestNow', appVersion: '1.0.9.0-fake',
      pid: process.pid, port: fake.address().port, seq, ...SSE_GEO,
    }));
  }
  if (url.pathname === '/v1/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/v1/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      received.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, applied: true, next_at: '2026-11-06T22:30:00+08:00' }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not-found' }));
});

/* ---------------- 几何断言小工具 ---------------- */
const frame = (() => {
  const sw = SSE_GEO.screen.w;
  const workH = SSE_GEO.screen.workH;
  const bias = PET_SIZE * 0.169;
  const pw = Math.round(PET_SIZE * 0.502);
  const ph = Math.round(PET_SIZE * 0.632);
  return {
    pw, ph,
    // 与 lib/index.js 的 PET_CAL 同一套换算
    box: (nx, ny) => ({
      x: nx * sw - pw / 2,
      y: ny * workH + bias - ph / 2,
      w: pw,
      h: ph,
    }),
  };
})();

function overlap(a, b, pad = 0) {
  return !(a.x + a.w + pad <= b.x || a.x >= b.x + b.w + pad
    || a.y + a.h + pad <= b.y || a.y >= b.y + b.h + pad);
}

/* ---------------- 走 ---------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => fakePet.listen(0, '127.0.0.1', r));
const petPort = fakePet.address().port;
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakePort = fake.address().port;

const dir = mkdtempSync(join(tmpdir(), 'dsh-rn-smoke-'));
const descPath = join(dir, 'bridge.json');
writeFileSync(
  descPath,
  JSON.stringify({ v: 1, port: fakePort, token: TOKEN, pid: process.pid, startedAt: Date.now() / 1000, appVersion: '1.0.9.0-fake' }),
);

// ① 单测 BridgeClient 本身
const client = new BridgeClient({ bridgeFile: descPath }, {});
ck('probe 探到假桥', await client.probe());
ck('probe 拿到端口', client.port === fakePort, `port=${client.port}`);
const act = await client.action('snooze', { minutes: 15 });
ck('action 正常返回', act && act.ok, JSON.stringify(act));
ck('动作真的发到了对端', received.length === 1 && received[0].type === 'snooze');
client.stop();

// ② 整插件：显式指向假桥 + 假桌宠，验证事件 → 状态
const disposers = [];
const ctx = {
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
  },
  commands: { register() { return () => {}; } },
  provide() {},
  get() { return null; },
};

apply(ctx, {
  bridgePort: 47198, bridgeFile: descPath, watchWindows: false,
  pollMs: 60000, petPort, petId: 'main',
});
await wait(2500);

const base = 'http://127.0.0.1:47198';
const getJson = async (p) => (await fetch(base + p)).json();

let st = await getJson('/status');
ck('插件进入桥接模式', st.bridgeMode === true, JSON.stringify(st.bridge));
ck('SSE 已连接', st.bridge && st.bridge.connected === true);
ck('桌宠走的是假宠物', st.pet && st.pet.port === petPort, `port=${st.pet && st.pet.port}`);
ck('读到桌宠尺寸', st.pet && st.pet.size === PET_SIZE, `size=${st.pet && st.pet.size}`);
ck('读到表情图表', st.pet && st.pet.memes === Object.keys(MEMES).length, `memes=${st.pet && st.pet.memes}`);

// ---- 表情图：休息开始 ----
pushEvent('rest.shown', {
  duration_sec: 120, forced: false, fullscreen: false,
  credit: 80, today_count: 3, geo: SSE_GEO,
});
await wait(700);
st = await getJson('/status');
ck('rest.shown → breakActive', st.breakActive === true);
ck('休息事件计数 +1', st.stats.breakStarts >= 1);

const say1 = petCalls.say[0] || {};
// ★ 2026-11-07：原来配的是「压力一只大肥鱼」（冒汗喊压力）——
//   跟「该歇会儿啦」的场景不搭，用户要求换掉。现在是「可爱」（卖萌提醒）。
ck('休息开始带表情图', say1.image === '可爱', JSON.stringify(say1));
ck('表情图来自桌宠 memes 表', Boolean(say1.image) && Object.keys(MEMES).includes(say1.image));

// ★ 2026-11-07：台词写的是「起来走两步」，动画不能是鱼自己躺下睡
//   （原来配「原地小憩沉眠」/「深度睡眠」⇒ 字和图反向，跟「压力一只大肥鱼」一个毛病）。
const SLEEPY = ['原地小憩沉眠', '深度睡眠', '睡觉-开始', '睡觉-循环'];
const restAnim = petCalls.anim.filter((a) => a !== '待机呼吸休闲');
ck('休息动画不是「鱼自己睡」', restAnim.every((a) => !SLEEPY.includes(a)),
  JSON.stringify(restAnim));
ck('休息动画是真动画名', restAnim.length > 0, JSON.stringify(petCalls.anim));

// ---- 陪工位：坐到弹窗旁边 ----
const move1 = petCalls.move[0];
ck('休息弹窗出现 → 桌宠挪位', Boolean(move1), JSON.stringify(petCalls.move));
if (move1) {
  const box = frame.box(move1.x, move1.y);
  ck('落点不压弹窗', !overlap(box, SSE_GEO.popup), JSON.stringify(box));
  ck('落点不压番茄钟', !overlap(box, SSE_GEO.tomato), JSON.stringify(box));
  ck('落点在工作区内', box.x >= 0 && box.y >= 0
    && box.x + box.w <= SSE_GEO.screen.w
    && box.y + box.h <= SSE_GEO.screen.workH, JSON.stringify(box));
  ck('移动方式可配置', ['instant', 'spring', 'line'].includes(move1.mode), String(move1.mode));
} else {
  ck('落点不压弹窗', false, 'no move');
  ck('落点不压番茄钟', false, 'no move');
  ck('落点在工作区内', false, 'no move');
  ck('移动方式可配置', false, 'no move');
}
ck('陪工位状态已记录', st.seat && st.seat.at && st.seat.why === 'rest', JSON.stringify(st.seat));

// ---- 全屏弹窗：整屏遮罩 + 居中卡片 —— 鱼要站在**卡片**上沿，不能因为「占满屏」放弃 ----
const FULL_CARD = { x: 995, y: 656, w: 570, h: 287 };
petCalls.move.length = 0;
pushEvent('rest.dismissed', { elapsed_sec: 120, geo: SSE_GEO });
await wait(300);
pushEvent('rest.shown', {
  duration_sec: 120, forced: false, fullscreen: true,
  credit: 80, today_count: 4,
  geo: {
    ...SSE_GEO,
    popup: { x: 0, y: 0, w: 2560, h: 1600 },   // 遮罩铺满整屏
    popup_card: FULL_CARD,                     // 真正的内容卡片
  },
});
await wait(800);
const moveFull = petCalls.move[0];
ck('全屏弹窗也会陪（不再放弃）', Boolean(moveFull), JSON.stringify(petCalls.move));
if (moveFull) {
  const box = frame.box(moveFull.x, moveFull.y);
  ck('全屏落点不压卡片', !overlap(box, FULL_CARD), JSON.stringify(box));
  ck('全屏落点在卡片上沿', box.y + box.h <= FULL_CARD.y + 2,
    `fishBottom=${Math.round(box.y + box.h)} cardTop=${FULL_CARD.y}`);
} else {
  ck('全屏落点不压卡片', false, 'no move');
  ck('全屏落点在卡片上沿', false, 'no move');
}
pushEvent('rest.dismissed', { elapsed_sec: 120, geo: SSE_GEO });
await wait(300);

pushEvent('timer.paused', { paused: true });
await wait(400);
st = await getJson('/status');
ck('timer.paused → restnowPaused', st.restnowPaused === true);

// ---- 回到原位 ----
pushEvent('rest.dismissed', { elapsed_sec: 118, escape_used: 0, credit: 82 });
await wait(700);
st = await getJson('/status');
ck('rest.dismissed → breakActive 复位', st.breakActive === false);
ck('休息结束计数 +1', st.stats.breakEnds >= 1);
const moveBack = petCalls.move[petCalls.move.length - 1];
ck('休息结束 → 桌宠归位', petCalls.move.length >= 2
  && moveBack.x > 0.9 && moveBack.y < 0.2, JSON.stringify(moveBack));
ck('陪工位状态已复位', st.seat && st.seat.at === null, JSON.stringify(st.seat));

// ---- 「家」= 桌宠配置里的停靠角（top-right）----
// ★ 2026-11-07 修正（反馈 #2：鱼本在右上角，关窗却飞到左上角）：
//   真实桌宠的 /state.position.data **恒为 {x:0,y:0}**（实测探针确认），并不可用于反推「家」，
//   用它当 home 会把鱼归位到左上角。故「家」统一由 /config 的 corner+margin 计算，
//   即用户在桌宠设置里选的停靠角 —— 正是用户期望的归位点。
//   （早期 1.3.4 的「拖到哪回哪」基于错误的 live 坐标假设，对真实桌宠无效，已停用；
//   这里刻意设置 fakePos=中下部，验证它**不再**被当成「家」。）
fakePos = { x: 0.42, y: 0.61 };
petCalls.move.length = 0;
pushEvent('rest.shown', { duration_sec: 120, forced: false, fullscreen: false, geo: SSE_GEO });
await wait(700);
ck('拖着鱼时弹提醒 → 仍然正常落座', petCalls.move.length >= 1, JSON.stringify(petCalls.move));
pushEvent('rest.dismissed', { elapsed_sec: 120, geo: SSE_GEO });
await wait(900);
const backHome = petCalls.move[petCalls.move.length - 1] || {};
// 关键：关窗后回到「配置的右上角」，而不是被 fakePos（中下部）带偏，也不是误飞到左上角。
ck('收窗回到配置的停靠角（右上角，不受 fakePos 干扰）',
  backHome.x > 0.9 && backHome.y < 0.2 && Math.abs(backHome.x - 0.42) > 0.1,
  JSON.stringify(backHome));

// ---- 提前关窗（休息没走完就关）----
// ★ 台词是「这么快就坐回去了？起来走两步嘛」= 打趣催促。
//   原来配「就骚了怎么滴吧」（叉腰嘴硬 = 我偏要），跟台词反向，换「可爱」。
petCalls.say.length = 0;
pushEvent('rest.shown', { duration_sec: 120, forced: false, fullscreen: false, geo: SSE_GEO });
await wait(700);
// break-end 有 5 秒节流（`allowed('break-end', 5000)`）——
// 上一段刚发过收尾台词，这里不等够就被节流吞掉，断言会拿到空对象。
await wait(5200);
petCalls.say.length = 0;
pushEvent('rest.dismissed', { elapsed_sec: 4, geo: SSE_GEO });
await wait(800);
const sayQuick = petCalls.say[petCalls.say.length - 1] || {};
ck('提前关窗换成催促台词', /起来走两步/.test(String(sayQuick.text || '')), JSON.stringify(sayQuick));
ck('提前关窗表情与台词同向', sayQuick.image === '可爱', JSON.stringify(sayQuick));

// ---- 陪工位：专注开始，坐到番茄钟旁边 ----
pushEvent('pomo.started', { minutes: 25, geo: SSE_GEO });
await wait(700);
const move2 = petCalls.move[petCalls.move.length - 1];
if (move2) {
  const box = frame.box(move2.x, move2.y);
  ck('专注开始 → 挪到番茄钟旁', !overlap(box, SSE_GEO.tomato), JSON.stringify(box));
  ck('陪番茄钟时不压弹窗', !overlap(box, SSE_GEO.popup), JSON.stringify(box));
} else {
  ck('专注开始 → 挪到番茄钟旁', false, 'no move');
  ck('陪番茄钟时不压弹窗', false, 'no move');
}
// ★ 2026-11-07：专注开始这张图改成**不带图**。原来配「誓死践行开源精神」
//   （庄重敬礼），跟「开干了」不搭。这里断言「没图，且不影响台词照发」。
const sayFocus = petCalls.say.find((s) => s && /开干/.test(String(s.text || '')));
ck('专注开始有台词', Boolean(sayFocus), JSON.stringify(petCalls.say.map((s) => s && s.text)));
ck('专注开始不带不搭的表情图', !sayFocus || !sayFocus.image, JSON.stringify(sayFocus));

// ---- 番茄钟被拖走后跟着走 ----
const movedGeo = { ...SSE_GEO, tomato: { x: 900, y: 500, w: 172, h: 198 } };
pushEvent('timer.tick', { remain_sec: 900, paused: false, geo: movedGeo });
await wait(700);
st = await getJson('/status');
const move3 = petCalls.move[petCalls.move.length - 1];
ck('番茄钟拖走 → 跟着重落座', petCalls.move.length >= 3 && move3 !== move2, JSON.stringify(move3));
if (move3) {
  const box = frame.box(move3.x, move3.y);
  ck('新落点不压番茄钟', !overlap(box, movedGeo.tomato), JSON.stringify(box));
} else {
  ck('新落点不压番茄钟', false, 'no move');
}

// ---- 番茄完成 ----
pushEvent('pomo.logged', { kind: 'rest', focus_sec: 1500, rest_sec: 120, quick: false, total: 12 });
await wait(700);
st = await getJson('/status');
ck('真休息 → 记一轮完成', st.stats.pomoCompleted >= 1);

pushEvent('pomo.logged', { kind: 'quick', focus_sec: 60, rest_sec: 2, quick: true, total: 13 });
await wait(500);
st = await getJson('/status');
ck('快速退出不记完成', st.stats.pomoCompleted === 1);

// 番茄完成的表情图：真机上刚休息完 12s 内刻意不庆祝（免得连吵两次），
// 所以这里走控制面直接触发一次，专门核对文案 + 表情图。
await fetch(base + '/simulate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic: 'pomo' }),
});
await wait(700);
const sayPomo = petCalls.say.find((s) => s && s.image === '厉害了我的鲸');
ck('番茄完成带表情图', Boolean(sayPomo), JSON.stringify(petCalls.say.map((s) => s && s.image)));

// ---- 刚弹就关：不夸，嘴硬 ----
pushEvent('remind.snoozed', { minutes: 30 });
await wait(500);
const saySnooze = petCalls.say.find((s) => s && s.image === '哦鲸鲸');
ck('推迟提醒带表情图', Boolean(saySnooze), JSON.stringify(petCalls.say.map((s) => s && s.image)));

// ③ 反向：插件控制面 → 假桥
const before = received.length;
const r = await fetch(base + '/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'snooze', args: { minutes: 30 } }),
});
const rj = await r.json();
ck('控制面 /action 返回 ok', r.status === 200 && rj.ok, JSON.stringify(rj));
ck('动作转发到歇会儿', received.length === before + 1 && received[received.length - 1].type === 'snooze');

// ④ 控制面可查
const xr = await fetch(base + '/bridge');
ck('/bridge 有统计', xr.status === 200 && (await xr.json()).events >= 4);

// ⑤ app.bye 后应退出桥接模式
pushEvent('app.bye', { reason: 'quit' });
await wait(800);
st = await getJson('/status');
ck('app.bye → 退出桥接模式', st.bridgeMode === false);

// ---- 歇够 5 分钟 → 夸他「在爱护身体」（不是夸他听话）----
await wait(5200);                       // 躲开 break-end 的 5 秒节流
petCalls.say.length = 0;
pushEvent('rest.shown', {
  duration_sec: 600, forced: false, fullscreen: false,
  credit: 80, today_count: 5, geo: SSE_GEO,
});
await wait(600);
pushEvent('rest.dismissed', { elapsed_sec: 360, geo: SSE_GEO });
await wait(800);
const praise = petCalls.say[petCalls.say.length - 1] || {};  // 最后一条才是收尾那句
ck('歇够5分钟 → 夸用户爱护身体', /爱护/.test(String(praise.text || '')), JSON.stringify(praise));
ck('歇够5分钟 → 用「吃饱饱摸肚子」表情', praise.image === '吃饱饱摸肚子', JSON.stringify(praise));
ck('歇够5分钟 → 计数 +1', (await getJson('/status')).stats.longRests >= 1);

// ---- 只歇了 2 分钟：不该夸 ----
await wait(5200);
petCalls.say.length = 0;
pushEvent('rest.shown', {
  duration_sec: 120, forced: false, fullscreen: false,
  credit: 80, today_count: 6, geo: SSE_GEO,
});
await wait(600);
pushEvent('rest.dismissed', { elapsed_sec: 120, geo: SSE_GEO });
await wait(800);
const mid = petCalls.say[petCalls.say.length - 1] || {};
ck('只歇2分钟 → 不夸（普通收尾）', !/爱护/.test(String(mid.text || '')), JSON.stringify(mid));

for (const d of disposers) {
  try {
    d();
  } catch {
    /* ignore */
  }
}
await wait(300);
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}
fake.close();
fakePet.close();
for (const s of sseClients) {
  try {
    s.end();
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r2) => !r2.ok);
for (const r2 of results) {
  console.log((r2.ok ? '  OK   ' : '  FAIL ') + r2.label + (r2.detail && !r2.ok ? `  << ${r2.detail}` : ''));
}
console.log(`PASS=${results.length - failed.length} FAIL=${failed.length}  (plugin=${name})`);
process.exit(failed.length ? 1 : 0);
