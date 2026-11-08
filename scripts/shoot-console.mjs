/**
 * 用无头 Edge + CDP 拍 Web 控制台截图，不弹窗、不动用户桌面、零第三方依赖。
 *
 * ★ 为什么不能直接用 `--window-size=390,844 --screenshot`：
 *   headless Edge 会把视口钳到最小 500px，截图裁成 390 只是把页面**右边切掉**
 *   （卡片右圆角、右边距全没了），看起来像响应式 bug，其实是拍摄工具的问题。
 *   必须用 `Emulation.setDeviceMetricsOverride` 精确设视口。
 *
 * 用法：
 *   node scripts/shoot-console.mjs                    # 拍默认两张
 *   node scripts/shoot-console.mjs 390 844 out.png   # 自定义尺寸 / 文件名
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'market', 'screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.env.RN_CONSOLE_URL || 'http://127.0.0.1:47110/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = process.argv.length > 2
  ? [{ w: Number(process.argv[2]), h: Number(process.argv[3]), file: process.argv[4], mobile: true }]
  : [
      { w: 1280, h: 800, file: '03-web-console.png', mobile: false },
      { w: 390, h: 844, file: '04-web-console-mobile.png', mobile: true },
    ];

mkdirSync(OUT_DIR, { recursive: true });
if (!existsSync(EDGE)) {
  console.error('找不到 Edge：' + EDGE);
  process.exit(2);
}

const profile = join(ROOT, '.icon-work', 'edge-cdp-' + process.pid);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-extensions', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

async function getPort() {
  const f = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(f)) return Number(readFileSync(f, 'utf8').split(/\r?\n/)[0]);
    await sleep(150);
  }
  throw new Error('Edge DevTools 端口没起来');
}

function cdp(ws) {
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error('CDP timeout: ' + method)); }
    }, 15000);
  });
}

let ws = null;
try {
  const port = await getPort();
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page tab');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = cdp(ws);
  await send('Page.enable');

  for (const shot of SHOTS) {
    if (!Number.isFinite(shot.w) || !Number.isFinite(shot.h) || !shot.file) {
      throw new Error('用法：node scripts/shoot-console.mjs <宽> <高> <文件名.png>');
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: shot.mobile,
    });
    await send('Page.navigate', { url: URL });
    await sleep(2200);   // 让 /api/features 与状态灯渲染完
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const out = join(OUT_DIR, shot.file);
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log(`✓ ${shot.file}  ${shot.w}x${shot.h}  ${readFileSync(out).length} bytes`);
  }
} catch (e) {
  console.error('截图失败：', String(e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
