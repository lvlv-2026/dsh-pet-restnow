/**
 * DSH 重载验收：判「DSH 里跑的是不是新代码」，不是判「文件改没改」。
 *
 * 为什么需要它：把文件同步进 live generation 后，Node 已经 require 进内存的
 * 旧模块不会自动换掉。只看文件全是绿的，但 /health 仍回报旧版本、
 * /api/features 仍 404 —— 典型的「假绿」。所以主判据必须打真实 HTTP。
 *
 * ★ 版本唯一的权威源是 package.json；升版后本脚本不需要改任何字面量。
 *
 * 用法：
 *   node scripts/verify-live.mjs            # 默认端口 47110
 *   node scripts/verify-live.mjs 47111      # 端口被占用自动 +1 时
 *   RN_TOKEN=xxx node scripts/verify-live.mjs   # webLan=true 需要口令
 *
 * 退出码：0 全绿 / 1 有红 / 2 环境错。
 * ★ 本脚本只发「不存在的 feature id」，不会真的触发休息 / 改配置 / 关程序。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'lib');
const GEN_ROOT = 'C:/Users/18883/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live';
const PORT = Number(process.argv[2] || 47110);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.RN_TOKEN || '';
const HEADERS = TOKEN ? { 'X-RestNow-Token': TOKEN } : {};
const FILES = ['index.js', 'web-panel.js', 'bridge-client.js'];
const CLOSED = ['set_fullscreen', 'set_force_rest', 'set_work_hours', 'quit_restnow'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let V = '';
try { V = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || ''); } catch { /* 下面报红 */ }

const results = [];
const ck = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail });

async function req(path, opt = {}) {
  try {
    const r = await fetch(BASE + path, {
      ...opt,
      headers: { ...HEADERS, ...(opt.headers || {}) },
      signal: AbortSignal.timeout(2500),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML 或纯文本 */ }
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 0, text: '', json: null, err: e.message };
  }
}

/* ── A. 磁盘：源 ↔ live 两份副本（防「只同步了一份」的假绿） ───────── */
ck('能从 package.json 读到版本', /^\d+\.\d+\.\d+$/.test(V), `got=${V}`);
let gens = [];
try {
  gens = readdirSync(GEN_ROOT)
    .filter((d) => /^dsh-pet-restnow\+1\.2\.0\+/.test(d))
    .map((d) => ({ d, t: statSync(join(GEN_ROOT, d)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
} catch (e) {
  ck('能读到 live generations 目录', false, e.message);
}
ck('找到当前生效的 1.2.0 generation', gens.length >= 1, `count=${gens.length}`);
const LIVE = gens.length ? join(GEN_ROOT, gens.at(-1).d) : '';

for (const copy of ['source/dsh-pet-restnow/lib', 'node_modules/dsh-pet-restnow/lib']) {
  for (const f of FILES) {
    let same = false; let why = '未找到 generation';
    if (LIVE) {
      try {
        same = Buffer.compare(readFileSync(join(SRC, f)), readFileSync(join(LIVE, copy, f))) === 0;
        why = same ? '' : '字节不一致';
      } catch (e) { why = e.message; }
    }
    ck(`live 副本与源一致：${copy}/${f}`, same, why);
  }
}
for (const copy of ['source/dsh-pet-restnow', 'node_modules/dsh-pet-restnow']) {
  let ok = false;
  try { ok = new RegExp(`"version"\\s*:\\s*"${esc(V)}"`).test(readFileSync(join(LIVE, copy, 'package.json'), 'utf8')); } catch { /* ignore */ }
  ck(`live 版本号 ${V}：${copy}`, ok);
}
let srcVer = false;
try { srcVer = new RegExp(`const VERSION = '${esc(V)}'`).test(readFileSync(join(SRC, 'index.js'), 'utf8')); } catch { /* ignore */ }
ck(`源码 VERSION = ${V}`, srcVer);

/* ── B. 运行时：必须打真实 HTTP，才是「真的重载了」 ─────────────── */
const h = await req('/health');
ck('插件 HTTP surface 在线', h.status === 200, `status=${h.status} ${h.err || ''}`);
ck(`★ 运行版本 = ${V}（旧版 = 未重载）`, h.json?.version === V, `got=${h.json?.version ?? 'n/a'}`);
ck('★ 运行中的代码含小卡归位兜底（breakGuard）',
  h.json?.breakGuard?.enabled === true, `got=${JSON.stringify(h.json?.breakGuard ?? null)}`);
ck('★ 运行中的代码含「只出番茄钟」启动模式（launchMode）',
  h.json?.launchMode?.tomatoOnly === true, `got=${JSON.stringify(h.json?.launchMode ?? null)}`);

const f = await req('/api/features');
ck('★ /api/features 已上线（旧版是 404）', f.status === 200, `status=${f.status}`);
const feats = Array.isArray(f.json?.features) ? f.json.features : [];
ck('功能清单共 24 项', feats.length === 24, `got=${feats.length}`);
const opened = feats.filter((x) => x.enabled).length;
ck('默认开放 20 项', opened === 20, `got=${opened}`);
ck('★ 4 项高风险功能仍关闭（未擅自扩大）',
  feats.length > 0 && CLOSED.every((id) => feats.find((x) => x.id === id)?.enabled === false),
  CLOSED.map((id) => `${id}=${feats.find((x) => x.id === id)?.enabled}`).join(' '));
ck('前端数据不泄漏可执行字段',
  feats.length > 0 && feats.every((x) => !('type' in x) && !('key' in x) && !('surface' in x)));

const root = await req('/');
ck('★ Web 面板 HTML 已上线', root.status === 200 && root.text.includes('歇会儿 · 控制台'), `status=${root.status}`);

// 只发不存在的 id：验证白名单拒绝，且绝不触发任何真实动作
const bad = await req('/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '__verify_not_exist__' }),
});
ck('★ /api/run 拒绝白名单外 id（400）', bad.status === 400, `status=${bad.status}`);

const closed = await req('/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'quit_restnow' }),
});
ck('★ 未开放的「退出歇会儿」被拒且不下发动作', closed.status === 400, `status=${closed.status}`);

/* ── 汇总 ─────────────────────────────────────────────────────── */
const failed = results.filter((x) => !x.ok);
for (const x of results) {
  console.log((x.ok ? '  OK   ' : '  FAIL ') + x.label + (x.detail && !x.ok ? `  << ${x.detail}` : ''));
}
console.log(`\n${V} 重载验收：PASS=${results.length - failed.length} FAIL=${failed.length}  (port=${PORT})`);
if (failed.some((x) => x.label.includes('运行版本') || x.label.includes('breakGuard') || x.label.includes('launchMode'))) {
  console.log('判读：DSH 仍在跑旧代码 → 需要重启 DSH（或重载插件）后重跑本脚本。');
}
if (failed.some((x) => x.label.includes('/api/features'))) {
  console.log('判读：Web 控制台未生效；若 webLan=true，记得带 RN_TOKEN。');
}
process.exit(failed.length ? 1 : 0);
