/**
 * 商城截图 01 / 02 的一键真机拍摄器（03 / 04 由 shoot-console.mjs 拍）。
 *
 * 为什么需要它：01「全屏休息弹窗 + 鱼站在卡片上方」和 02「右键更多菜单」
 * 都必须是**真机画面**，无头浏览器拍不出来，也不能拿示意图充数。
 *
 * 用法（解锁屏幕后再跑；锁屏会明确拒绝，不会交出一张壁纸当截图）：
 *   node scripts/shoot-desktop.mjs                       # 01 + 02
 *   node scripts/shoot-desktop.mjs --only fullscreen     # 只拍 01
 *   node scripts/shoot-desktop.mjs --only menu           # 只拍 02
 *   node scripts/shoot-desktop.mjs --click 2027 362      # 手动指定桌宠身体中心（抓屏物理坐标）
 *   node scripts/shoot-desktop.mjs --check               # 只做环境探针，不改任何状态
 *   PYTHON=<带 PIL 的 python.exe> node scripts/shoot-desktop.mjs
 *
 * 前置：歇会儿已启动且本机桥可用、dsh-pet 处于「桌面/两者」模式、
 *       屏幕上没有含个人信息的窗口（02 会裁到背景，建议先最小化）。
 *
 * ★ 会触发一次真实休息并用 ack_rest 收尾：歇会儿统计里会多一次休息记录，
 *   这是真实截图的代价，不掩饰。ack_rest 会广播 rest.dismissed，鱼会正常归位。
 *
 * 退出码：0 成功 / 2 参数或环境错 / 3 锁屏 / 4 前置条件不满足 / 5 拍摄失败。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'scripts', '_shoot_cap.py');
const OUT_DIR = join(ROOT, 'market', 'screenshots');
const PY = process.env.PYTHON
  || 'C:/Users/18883/.workbuddy/binaries/python/envs/health312/Scripts/python.exe';
const BRIDGE_DESC = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'RestNow', 'bridge.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const ONLY = opt('--only', 'all');
const pair = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 2 >= argv.length) return null;
  const v = [Number(argv[i + 1]), Number(argv[i + 2])];
  return v.every(Number.isFinite) ? v : null;
};
const CLICK = pair('--click');
const HOVER = pair('--hover');   // 「更多」行的物理屏幕坐标，校准时用
const CHECK_ONLY = argv.includes('--check');

function py(args) {
  const r = spawnSync(PY, [HELPER, ...args], { encoding: 'utf8', timeout: 60000 });
  if (r.error) return { ok: false, why: 'python-spawn-failed', detail: String(r.error) };
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim().split(/\r?\n/).at(-1) || ''); } catch { /* 下面统一报 */ }
  if (r.status === 3) return { ...(out || {}), ok: false, why: 'locked' };
  if (!out) return { ok: false, why: 'bad-helper-output', detail: (r.stderr || r.stdout || '').slice(0, 500) };
  return out;
}

async function bridgeAction(type, args = {}) {
  let desc;
  try { desc = JSON.parse(readFileSync(BRIDGE_DESC, 'utf8')); } catch (e) {
    throw new Error(`读不到桥描述文件 ${BRIDGE_DESC}：${e.message}（歇会儿没启动？）`);
  }
  const body = {
    v: 1, type, args, issued_by: 'shoot-desktop',
    ts: Date.now() / 1000,
    id: `shot-${randomBytes(4).toString('hex')}`,
  };
  const r = await fetch(`http://127.0.0.1:${desc.port}/v1/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${desc.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const j = await r.json();
  return { status: r.status, json: j };
}

async function main() {
  if (!existsSync(HELPER)) throw new Error(`缺少助手脚本 ${HELPER}`);
  const p = py(['probe']);
  console.log('环境探针：', JSON.stringify({
    locked: p.locked, screen: p.screen, scale: p.scale,
    pet: p.pet?.rect ?? null, foreground: p.foreground?.title ?? null,
  }));
  if (CHECK_ONLY) {
    console.log(p.locked
      ? '⛔ 当前锁屏：请解锁后重跑。锁屏状态下抓到的是壁纸，不是产品画面。'
      : '✅ 桌面可交互，可以补拍 01 / 02。');
    process.exit(p.locked ? 3 : 0);
  }
  if (p.locked) {
    console.error('⛔ 当前是 Windows 锁屏界面，拒绝拍摄（否则会交出一张壁纸当「真机截图」）。');
    console.error('   解锁屏幕、把含个人信息的窗口最小化后重跑本脚本。');
    process.exit(3);
  }
  if (!p.pet) {
    console.error('⛔ 没找到 dsh-pet 桌面窗口；请把桌宠切到「桌面 / 两者」显示模式。');
    process.exit(4);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  const ck = (label, ok, detail = '') => {
    results.push({ label, ok: Boolean(ok), detail });
    console.log((ok ? '  OK   ' : '  FAIL ') + label + (!ok && detail ? `  << ${JSON.stringify(detail)}` : ''));
  };

  /* ── 01：真实触发一次休息 → 等全屏弹窗 → 抓整屏 → 缩到 1280×800 ── */
  if (ONLY === 'all' || ONLY === 'fullscreen') {
    let opened = null;
    try {
      const r = await bridgeAction('rest_now');
      opened = r.json;
      ck('rest_now 动作已下发', r.status === 200 && r.json?.ok !== false, r.json);
      ck('★ 休息弹窗确实打开了（applied）', r.json?.applied === true, r.json);
    } catch (e) {
      ck('rest_now 动作已下发', false, e.message);
    }
    if (opened?.applied === true) {
      let seen = false;
      for (let i = 0; i < 16; i += 1) {
        await sleep(500);
        const q = py(['probe']);
        if (q.fullscreenPopup) { seen = true; break; }
      }
      ck('★ 窗口观察器能看到全屏休息弹窗', seen);
      await sleep(1500);  // 给桌宠落座留时间：01 要拍到「鱼站在卡片正上方」
      const out = join(OUT_DIR, '01-fullscreen.png');
      const cap = py(['fullscreen', out, '1280', '800']);
      ck('★ 01-fullscreen.png 已生成（1280×800，真实桌面）',
        cap.ok === true && existsSync(out), cap);
    }
    // 无论成功与否都收尾，绝不把休息弹窗留在用户屏幕上
    try { await bridgeAction('ack_rest'); } catch { /* 下面不因此判红 */ }
    await sleep(900);
  }

  /* ── 02：合成右键 → 差分自检菜单真弹了 → 裁切缩到 800×600 → Esc ── */
  if (ONLY === 'all' || ONLY === 'menu') {
    // ★ 拍 02 前先收掉任何「到点自己弹出来」的全屏休息弹窗：
    //   它整屏深色遮罩会把差分自检骗成「菜单弹了」（2026-11-07 实证假绿）。
    //   ack_rest 会广播 rest.dismissed，桌宠正常归位，不留脏状态。
    try { await bridgeAction('ack_rest'); } catch { /* 没有弹窗时返回 no-popup，属正常 */ }
    await sleep(900);
    let q = py(['probe']);
    for (let i = 0; i < 12 && q.fullscreenPopup; i += 1) {
      await sleep(400);
      q = py(['probe']);
    }
    ck('★ 拍 02 前没有全屏休息弹窗遮挡（否则会把遮罩误判成菜单）',
      q.fullscreenPopup == null, q.fullscreenPopup);
    const out = join(OUT_DIR, '02-right-click-menu.png');
    // menu-more：先右键弹根菜单，再悬停最后一项「更多」展开二级菜单 ——
    // 商城这张图必须能看到插件注册的 6 个歇会儿项，只截到根菜单不算数。
    const args = ['menu-more', out, '800', '600'];
    if (CLICK) args.push('--click', String(CLICK[0]), String(CLICK[1]));
    if (HOVER) args.push('--hover', String(HOVER[0]), String(HOVER[1]));
    const cap = py(args);
    console.log('  菜单自检：', JSON.stringify({
      attempt: cap.menu?.attempt, changed: cap.menu?.changed,
      moreHovered: cap.moreHovered, cropBox: cap.cropBox,
    }));
    ck('★ 02-right-click-menu.png 已生成（800×600，菜单经差分确认弹出 + 悬停「更多」）',
      cap.ok === true && existsSync(out) && Array.isArray(cap.moreHovered), cap);
    if (!cap.ok) {
      console.error('   提示：若报 context-menu-not-detected，先跑 --check 看桌宠窗口，'
        + '再用 --click <物理X> <物理Y> 指定桌宠身体中心。');
    }
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n真机截图 01/02：PASS=${results.length - failed.length} FAIL=${failed.length}`);
  console.log('拍完跑：node scripts/verify-market.mjs --screenshots  （四图规格硬校验）');
  process.exit(failed.length ? 5 : 0);
}

main().catch((e) => {
  console.error('拍摄脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
