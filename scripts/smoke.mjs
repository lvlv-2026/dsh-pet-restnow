// 冒烟测试：用桩 ctx 加载插件，验证启动、桌宠发现、歇会儿配置读取、控制面与模拟动作。
import { apply, name } from '../lib/index.js';

const disposers = [];
const ctx = {
  effect(fn, label) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    else console.log('[smoke] effect without disposer:', label);
  },
  commands: {
    register(cmd) {
      console.log('[smoke] command registered:', cmd.name);
      return () => {};
    },
  },
  provide(key, api) {
    console.log('[smoke] provided service:', key, Object.keys(api));
  },
  get() {
    return null;
  },
};

console.log('[smoke] loading plugin', name);
apply(ctx, { bridgePort: 47199, pollMs: 1500 });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:47199${p}`);
  return { status: res.status, body: await res.json() };
};
const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:47199${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
};

await wait(3500);
const health = await get('/health');
console.log('[smoke] health:', JSON.stringify(health.body, null, 2));

const started = await post('/simulate', { topic: 'break-start' });
console.log('[smoke] simulate break-start:', started.status, started.body);
await wait(2500);

const ended = await post('/simulate', { topic: 'break-end' });
console.log('[smoke] simulate break-end:', ended.status, ended.body);
await wait(2500);

const pomo = await post('/simulate', { topic: 'pomo' });
console.log('[smoke] simulate pomo:', pomo.status, pomo.body);
await wait(2500);

const status = await get('/status');
console.log('[smoke] status:', JSON.stringify(status.body, null, 2));

for (const d of disposers) {
  try {
    d();
  } catch (e) {
    console.log('[smoke] dispose error', e.message);
  }
}
await wait(500);
process.exit(0);
