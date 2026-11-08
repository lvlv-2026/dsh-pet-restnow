/**
 * 商城上架资料校验器（零依赖，纯 Node）。
 *
 * 为什么要有它：上架资料是「配置 + 文案 + 二进制素材」的组合，肉眼全绿也可能错。
 * 历史上就踩过：官方公开的 index.json 其实变成了 schemaVersion-2 工作台目录，
 * 而插件收录用的是 format-1 索引 —— 单看每一行都正常，交过去就是格式错误。
 *
 * 用法：
 *   node scripts/verify-market.mjs                    # 全量校验（截图只提示，不判红）
 *   node scripts/verify-market.mjs --screenshots     # 四图规格硬校验 + 输出元数据
 *   node scripts/verify-market.mjs --strict-shots    # 全量 + 四图一起判红绿
 *
 * 正控（必须报红，证明检查器没瞎）：
 *   MARKET_INDEX=<改坏版本的索引副本> node scripts/verify-market.mjs
 *   MARKET_ICON=icon.png.bak.old     node scripts/verify-market.mjs
 *   MARKET_SHOTS_DIR=<缺图/错尺寸的目录> node scripts/verify-market.mjs --screenshots
 *
 * ★ 版本唯一的权威源是 package.json。校验器不再硬编码版本字面量 ——
 *   升版时改一处就够了，避免「校验器自己腐烂成恒绿」（2026-11-07 实证教训）。
 *
 * 可用环境变量覆盖被测文件：MARKET_ROOT / MARKET_INDEX / MARKET_ICON / MARKET_TGZ / MARKET_SHOTS_DIR
 * 退出码：0 全绿 / 1 有红 / 2 用法错。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = process.env.MARKET_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => join(ROOT, ...p);
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pkg = readJSON(R('package.json'));
const V = String(pkg?.version || '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const INDEX_PATH = process.env.MARKET_INDEX || R('market', 'index.example.json');
const ICON_PATH = process.env.MARKET_ICON || R('icon.png');
const TGZ_PATH = process.env.MARKET_TGZ || R(`dsh-pet-restnow-${V}.tgz`);
const CLOSED_IDS = ['set_fullscreen', 'set_force_rest', 'set_work_hours', 'quit_restnow'];
/** 商城四图的硬规格：文件名 / 像素尺寸一个都不能漂。 */
const SHOT_SPECS = [
  { file: '01-fullscreen.png', w: 1280, h: 800 },
  { file: '02-right-click-menu.png', w: 800, h: 600 },
  { file: '03-web-console.png', w: 1280, h: 800 },
  { file: '04-web-console-mobile.png', w: 390, h: 844 },
];
const MENU_LABELS = [
  '立即休息', '开始专注25min(番茄钟)', '开始专注35min(番茄钟)',
  '开始专注45min(番茄钟)', '暂停/恢复提醒', '延后5分钟',
];
const REQUIRED_FILES = [
  'lib', 'assets', 'cordis.patch.yml', 'README.md', '使用说明.md', 'LICENSE', 'icon.png',
];
const REQUIRED_IN_TGZ = [
  'package/lib/index.js', 'package/lib/web-panel.js', 'package/lib/bridge-client.js',
  'package/icon.png', 'package/使用说明.md', 'package/README.md', 'package/package.json',
  'package/cordis.patch.yml', 'package/assets/RwWin.cs', 'package/assets/watch-restnow.ps1',
];

const results = [];
const ck = (label, ok, detail = '') => results.push({ label, ok: Boolean(ok), detail });

/** 解 PNG（仅支持 8bit RGBA 非隔行），返回可按坐标取 alpha 的函数。 */
function decodePng(buf) {
  try {
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { bad: true, why: 'not-png' };
    let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        w = data.readUInt32BE(0); h = data.readUInt32BE(4);
        bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!w || !h || bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
      return { bad: true, why: `unsupported ${w}x${h} depth=${bitDepth} color=${colorType} interlace=${interlace}` };
    }
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = 4, stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    let p = 0;
    for (let y = 0; y < h; y++) {
      const ft = raw[p++];
      const line = raw.subarray(p, p + stride);
      p += stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[y * stride + x - bpp] : 0;
        const b = y > 0 ? out[(y - 1) * stride + x] : 0;
        const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
        let v = line[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        out[y * stride + x] = v & 255;
      }
    }
    return { w, h, bitDepth, colorType, alpha: (x, y) => out[y * stride + x * bpp + 3] };
  } catch (e) {
    return { bad: true, why: e.message };
  }
}

/** 从 tgz 里取一个文件的文本（校验「发布物里真的有修复」，不只看工作区）。 */
function tarRead(buf, wanted) {
  try {
    const raw = gunzipSync(buf);
    let off = 0;
    while (off + 512 <= raw.length) {
      const h = raw.subarray(off, off + 512);
      const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
      if (!name) break;
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8) || 0;
      if (name === wanted) return raw.subarray(off + 512, off + 512 + size).toString('utf8');
      off += 512 + Math.ceil(size / 512) * 512;
    }
  } catch { /* 下面统一报红 */ }
  return '';
}

/** 解 tgz，列出 tar 内文件名（不落地、不依赖系统 tar）。 */
function tarNames(buf) {
  try {
    const raw = gunzipSync(buf);
    const names = [];
    let off = 0;
    while (off + 512 <= raw.length) {
      const h = raw.subarray(off, off + 512);
      const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
      if (!name) break;
      const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8) || 0;
      names.push(name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * 通用 PNG 头/流检查：只解 IHDR + inflate IDAT，不取像素。
 * ★ 为什么不能复用 decodePng()：那个只吃 8bit RGBA（图标是 RGBA），
 *   而真机截图由 PIL 存成 RGB（colorType=2）→ 复用会「有效图却报不支持」。
 */
function pngInfo(buf) {
  try {
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { bad: true, why: 'not-png' };
    let off = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0, sawEnd = false;
    const idat = [];
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        w = data.readUInt32BE(0); h = data.readUInt32BE(4);
        depth = data[8]; ct = data[9]; interlace = data[12];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') { sawEnd = true; break; }
      off += 12 + len;
    }
    const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
    if (!w || !h || depth !== 8 || !bpp || interlace !== 0) {
      return { bad: true, why: `unsupported ${w}x${h} depth=${depth} color=${ct}` };
    }
    const raw = inflateSync(Buffer.concat(idat));
    const need = h * (1 + w * bpp);
    if (raw.length < need) return { bad: true, why: `truncated idat ${raw.length}/${need}` };
    return { bad: false, w, h, bitDepth: depth, colorType: ct, sawEnd };
  } catch (e) {
    return { bad: true, why: e.message };
  }
}

/** 四图硬校验：返回可并入 results 的断言数组 + 供交付用的元数据。 */
function checkShots(dir) {
  const out = [];
  const put = (label, ok, detail = '') => out.push({ label, ok: Boolean(ok), detail });
  const meta = [];
  put('market/screenshots/ 存在', existsSync(dir), dir);
  const list = existsSync(dir) ? readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort() : [];
  put('★ 恰好 4 张 PNG（无多余 / 临时 / 诊断图）', list.length === 4, list.join(',') || 'empty');
  for (const s of SHOT_SPECS) {
    const p = join(dir, s.file);
    let b = null;
    try { b = readFileSync(p); } catch { /* 下面统一报红 */ }
    put(`${s.file} 存在`, Boolean(b));
    const d = b ? pngInfo(b) : { bad: true, why: 'missing' };
    put(`★ ${s.file} 是有效 PNG（真解 IDAT）`, !d.bad, d.why || '');
    put(`★ ${s.file} 尺寸 = ${s.w}×${s.h}`,
      !d.bad && d.w === s.w && d.h === s.h, d.bad ? d.why : `${d.w}x${d.h}`);
    put(`${s.file} 体积 ≥ 8 KiB（防空白图 / 假截图）`,
      Boolean(b) && b.length >= 8192, `${b?.length ?? 0} bytes`);
    if (b) meta.push({
      file: s.file,
      width: d.bad ? null : d.w,
      height: d.bad ? null : d.h,
      bytes: b.length,
      sha256: createHash('sha256').update(b).digest('hex'),
    });
  }
  return { results: out, meta };
}

const SHOTS_DIR = process.env.MARKET_SHOTS_DIR || R('market', 'screenshots');

/* ── screenshots 硬校验模式（能报红绿，不是只打印元数据）────── */
if (process.argv.includes('--screenshots')) {
  const { results: shotResults, meta } = checkShots(SHOTS_DIR);
  for (const x of shotResults) {
    console.log((x.ok ? '  OK   ' : '  FAIL ') + x.label + (x.detail && !x.ok ? `  << ${x.detail}` : ''));
  }
  for (const m of meta) console.log('  META ' + JSON.stringify(m));
  const bad = shotResults.filter((x) => !x.ok).length;
  console.log(`\n商城四图规格校验：PASS=${shotResults.length - bad} FAIL=${bad}`);
  if (bad) console.log('判读：缺图 / 尺寸不对 / PNG 损坏 → 跑 node scripts/shoot-desktop.mjs 与 shoot-console.mjs 补拍。');
  process.exit(bad ? 1 : 0);
}

/* ── A. 包元数据 ───────────────────────────────────────────── */
ck('package.json 可解析', Boolean(pkg));
ck("包名 = dsh-pet-restnow", pkg?.name === 'dsh-pet-restnow', `got=${pkg?.name}`);
ck('★ 版本是合法三段式 semver', /^\d+\.\d+\.\d+$/.test(V), `got=${V}`);
ck('main 指向存在的入口', Boolean(pkg?.main) && existsSync(R(pkg.main)), `main=${pkg?.main}`);
ck('icon 字段指向存在的图标', Boolean(pkg?.icon) && existsSync(R(pkg.icon.replace(/^\.\//, ''))));
ck('homepage = https://xiehuier.cn', pkg?.homepage === 'https://xiehuier.cn');
ck('license = MIT', pkg?.license === 'MIT');
ck('engines.node = >=20', pkg?.engines?.node === '>=20');
ck('files 覆盖全部随包文件', REQUIRED_FILES.every((f) => (pkg?.files || []).includes(f)),
  `missing=${REQUIRED_FILES.filter((f) => !(pkg?.files || []).includes(f)).join(',')}`);
ck('dsh.bundle.patch 指向 cordis.patch.yml', pkg?.dsh?.bundle?.patch === './cordis.patch.yml');
ck(`★ lib/index.js 的 VERSION 与 package.json 一致 (${V})`,
  new RegExp(`const VERSION = '${esc(V)}'`).test(readText(R('lib', 'index.js'))));
ck('cordis.patch.yml 的 id 与包名一致（上架契约 entryId）',
  /-\s*id:\s*dsh-pet-restnow\b/.test(readText(R('cordis.patch.yml'))));

/* ── B. format-1 商城索引 ──────────────────────────────────── */
const idx = readJSON(INDEX_PATH);
ck('market/index.example.json 可解析', Boolean(idx), INDEX_PATH);
ck('★ format = 1（插件索引）', idx?.format === 1, `got=${idx?.format}`);
ck('★ 不含 schemaVersion / kind（防误用工作台目录格式）',
  Boolean(idx) && !('schemaVersion' in idx) && !('kind' in idx));
ck('索引 title 中英齐全', Boolean(idx?.title?.zh && idx?.title?.en));
ck('metadata.categories.productivity 已定义', Boolean(idx?.metadata?.categories?.productivity));
ck('metadata.labels 的 chinese / local-first 已定义',
  Boolean(idx?.metadata?.labels?.chinese && idx?.metadata?.labels?.['local-first']));
ck('plugins 恰好 1 条', Array.isArray(idx?.plugins) && idx.plugins.length === 1,
  `count=${idx?.plugins?.length}`);
const p0 = Array.isArray(idx?.plugins) ? idx.plugins[0] : {};
ck('plugins[0].name = package.name', p0?.name === pkg?.name);
ck('插件 title 中英齐全', Boolean(p0?.title?.zh && p0?.title?.en));
ck('★ 中文简介含「歇会儿」和官网（前置依赖不可漏）',
  /歇会儿/.test(p0?.description?.zh || '') && /xiehuier\.cn/.test(p0?.description?.zh || ''));
ck('英文简介含 RestNow 和官网',
  /RestNow/.test(p0?.description?.en || '') && /https:\/\/xiehuier\.cn/.test(p0?.description?.en || ''));
ck('icon 路径 = icons/dsh-pet-restnow.png', p0?.icon === 'icons/dsh-pet-restnow.png');
ck('icon 是相对路径（不是绝对 URL / 盘符路径）',
  Boolean(p0?.icon) && !/^(https?:|\/|[A-Za-z]:)/.test(p0.icon));
ck('author 与 package.json 一致', p0?.author === pkg?.author);
ck('homepage 与 package.json 一致', p0?.homepage === pkg?.homepage);
ck('category 在 metadata.categories 中有定义',
  Boolean(idx?.metadata?.categories?.[p0?.metadata?.category]));
ck('labels 每项都有定义',
  Array.isArray(p0?.metadata?.labels) && p0.metadata.labels.every((l) => idx?.metadata?.labels?.[l]));
ck('keywords 不少于 5 个', (p0?.metadata?.keywords || []).length >= 5,
  `count=${(p0?.metadata?.keywords || []).length}`);
ck('versions 非空', Array.isArray(p0?.versions) && p0.versions.length >= 1);
const v0 = Array.isArray(p0?.versions) ? p0.versions[0] : {};
ck('★ versions[0].version = package.version', v0?.version === pkg?.version,
  `index=${v0?.version} pkg=${pkg?.version}`);
ck('source.type = npm', v0?.source?.type === 'npm');
ck('engines.node 与 package.json 一致', v0?.engines?.node === pkg?.engines?.node);
const nowSec = Math.floor(Date.now() / 1000);
ck('publishTimestamp 是合理的 Unix 秒',
  Number.isInteger(v0?.publishTimestamp) && v0.publishTimestamp > 1700000000
  && v0.publishTimestamp <= nowSec + 86400, `got=${v0?.publishTimestamp}`);
ck('版本号无重复',
  new Set((p0?.versions || []).map((v) => v.version)).size === (p0?.versions || []).length);
ck('sortKeys.installs 是数字', typeof p0?.metadata?.sortKeys?.installs === 'number');

/* ── C. 图标规格（真解像素，不只看文件头） ─────────────────── */
// ★★ 阈值锚定「外部权威源」：DSH 源码 MAX_ICON_BYTES = 256 * 1024 (0x40000)，
//    越限时逐字报错 `${label}: icon exceeds 256 KiB`，插件元数据直接加载失败。
//    2026-11-07 实证：277100 bytes 的图标让 DSH 插件页报「包元数据错误」。
//    之前这里写的是拍脑袋的「< 500 KB」，等于没有守卫 —— 别再改回裸值。
const DSH_ICON_CAP = 256 * 1024;
const SAFE_CAP = 220 * 1024; // 留 36 KiB 余量，防止后续微调又贴边
let iconBuf = null;
try { iconBuf = readFileSync(ICON_PATH); } catch { /* 下面统一报红 */ }
const png = iconBuf ? decodePng(iconBuf) : { bad: true, why: 'missing' };
ck('图标是有效 PNG', !png.bad, png.why || '');
ck('★ 图标 512×512', !png.bad && png.w === 512 && png.h === 512,
  png.bad ? png.why : `${png.w}x${png.h}`);
ck('图标 8bit RGBA', !png.bad && png.bitDepth === 8 && png.colorType === 6);
const corners = png.bad ? [] : [
  png.alpha(0, 0), png.alpha(511, 0), png.alpha(0, 511), png.alpha(511, 511),
];
ck('★ 四角全透明（旧图标的白边瑕疵会被这条抓到）',
  corners.length === 4 && corners.every((a) => a === 0), `alpha=[${corners.join(',')}]`);
ck('中心不透明', !png.bad && png.alpha(256, 256) === 255);
ck('★ 图标体积 ≤ DSH MAX_ICON_BYTES (256 KiB)',
  Boolean(iconBuf) && iconBuf.length <= DSH_ICON_CAP,
  `${iconBuf?.length ?? 0} / ${DSH_ICON_CAP} bytes`);
ck('★ 图标留安全余量（≤ 220 KiB）',
  Boolean(iconBuf) && iconBuf.length <= SAFE_CAP,
  `${iconBuf?.length ?? 0} / ${SAFE_CAP} bytes`);

// 事故复发点：源改了但 DSH live 的两份副本没跟上（或三份都超限）
// generation 目录名 = `<plugin-name>+<dsh版本>+<hash>`，按名前缀 glob 取最新，避免写死旧名失效。
const GEN_ROOT = 'C:/Users/18883/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live';
const LIVE_GEN = (() => {
  try {
    return readdirSync(GEN_ROOT)
      .filter((d) => /^dsh-pet-restnow\+1\.2\.0\+/.test(d))
      .map((d) => ({ d, t: statSync(join(GEN_ROOT, d)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .at(-1)?.d || '';
  } catch { return ''; }
})();
const LIVE_GEN_DIR = LIVE_GEN ? join(GEN_ROOT, LIVE_GEN) : '';
if (LIVE_GEN_DIR && existsSync(LIVE_GEN_DIR)) {
  for (const rel of ['source/dsh-pet-restnow/icon.png', 'node_modules/dsh-pet-restnow/icon.png']) {
    const tag = rel.split('/')[0];
    let b = null;
    try { b = readFileSync(join(LIVE_GEN_DIR, rel)); } catch { /* 下面报红 */ }
    ck(`★ live 副本图标 ≤ 256 KiB：${tag}`,
      Boolean(b) && b.length <= DSH_ICON_CAP, `${b?.length ?? 'missing'} / ${DSH_ICON_CAP}`);
    ck(`live 副本图标与源逐字节一致：${tag}`,
      Boolean(b) && Boolean(iconBuf) && Buffer.compare(b, iconBuf) === 0);
  }
}

/* ── D. 文档与真实功能清单对账 ─────────────────────────────── */
const guide = readText(R('使用说明.md'));
ck('使用说明.md 存在', guide.length > 500);
ck(`使用说明标注当前版本 ${V}`, guide.includes(V));
ck('使用说明含官网地址', /https:\/\/xiehuier\.cn/.test(guide));
ck('★ 使用说明列全 6 个右键菜单真实标签',
  MENU_LABELS.every((l) => guide.includes(l)),
  MENU_LABELS.filter((l) => !guide.includes(l)).join(','));
ck('使用说明写明 20 个按钮', /20\s*(个|项)/.test(guide));
ck('使用说明写明 4 个默认没开放的功能',
  ['全屏弹窗', '强制休息', '仅工作时段提醒', '退出歇会儿'].every((s) => guide.includes(s)));
const readme = readText(R('README.md'));
const readmeTop = readme.slice(0, 1200);
ck('★ README 首屏写明「必须搭配歇会儿」+ 官网',
  /歇会儿/.test(readmeTop) && /xiehuier\.cn/.test(readmeTop));
ck('README 有《使用说明.md》导航', readme.includes('使用说明.md'));
ck('★ README 不再含过时的「每 2 秒最多动一次 z 序」说明',
  !/每 2 秒最多动一次 z 序/.test(readme));
const material = readText(R('market', '上架素材.md'));
ck(`上架素材.md 存在且标注当前版本 ${V}`, material.length > 500 && material.includes(V));
ck('上架素材说明两套索引格式的区别',
  /schemaVersion 2/.test(material) && /format-1/.test(material));

let feats = [];
try { ({ WEB_FEATURES: feats } = await import('../lib/web-panel.js')); } catch { /* 下面报红 */ }
const opened = (feats || []).filter((f) => f.enabled).length;
ck('★ WEB_FEATURES 共 24 项', (feats || []).length === 24, `got=${(feats || []).length}`);
ck('★ WEB_FEATURES 默认开放 20 项', opened === 20, `got=${opened}`);
ck('★ 4 项高风险功能仍关闭（未擅自扩大）',
  (feats || []).length > 0 && CLOSED_IDS.every((id) => feats.find((f) => f.id === id)?.enabled === false));
ck('★ 文档里的「20」与真实开放数一致', /20\s*(个|项)/.test(guide) && opened === 20);

/* ── E. 安装包内容 ─────────────────────────────────────────── */
let tgzBuf = null;
try { tgzBuf = readFileSync(TGZ_PATH); } catch { /* 下面统一报红 */ }
ck(`${V} 安装包已生成`, Boolean(tgzBuf), TGZ_PATH);
const names = tgzBuf ? tarNames(tgzBuf) : null;
ck('安装包可解析（gzip + tar）', Array.isArray(names) && names.length > 0);
ck('★ 安装包含全部必需文件',
  Array.isArray(names) && REQUIRED_IN_TGZ.every((f) => names.includes(f)),
  Array.isArray(names) ? REQUIRED_IN_TGZ.filter((f) => !names.includes(f)).join(',') : 'no-tar');
ck('★ 安装包不含临时 / 备份 / 素材文件',
  Array.isArray(names) && !names.some((n) => /\.bak|\.icon-work|^package\/(market|scripts|screenshots)\//.test(n)),
  Array.isArray(names) ? names.filter((n) => /\.bak|\.icon-work|^package\/(market|scripts|screenshots)\//.test(n)).join(',') : '');
const shippedIndex = tgzBuf ? tarRead(tgzBuf, 'package/lib/index.js') : '';
ck(`★ 发布包内 VERSION 也是 ${V}（防拿旧包顶替）`,
  new RegExp(`const VERSION = '${esc(V)}'`).test(shippedIndex));
ck('★ 发布包内确实含小卡归位兜底（不是只改了工作区）',
  /observeBreakPopup\s*\(/.test(shippedIndex) && /breakPopupGuard/.test(shippedIndex));
ck('★ 发布包内确实含 0.4.7 启动态修复（--startup + ping 判活）',
  /buildLaunchCommand\s*\(/.test(shippedIndex) && /STARTUP_ARG\s*=\s*'--startup'/.test(shippedIndex)
  && /await this\.bridge\.ping\(\)/.test(shippedIndex),
  { cmd: /buildLaunchCommand\s*\(/.test(shippedIndex), arg: /STARTUP_ARG\s*=\s*'--startup'/.test(shippedIndex), ping: /await this\.bridge\.ping\(\)/.test(shippedIndex) });
const shippedBridge = tgzBuf ? tarRead(tgzBuf, 'package/lib/bridge-client.js') : '';
ck('★ 发布包内 bridge-client 真的实现了 ping()', /async ping\(/.test(shippedBridge));
ck('★ 使用说明写明「只显示番茄钟、不弹主界面」',
  /只把番茄钟放上桌面|只显示番茄钟/.test(guide));
ck('★ README 写明 MSIX 降级口径（不假装做到了）',
  /MSIX 版用 `shell:AppsFolder\\<AppID>` 启动|Explorer 不转发参数/.test(readme));
ck('★ 上架素材变更日志含 0.4.7 章节', /### 0\.4\.7（当前）/.test(material));

/* ── F. 截图：默认只提示，--strict-shots 时一起判红 ────────── */
{
  const { results: sr } = checkShots(SHOTS_DIR);
  const ok = sr.filter((x) => x.ok).length;
  if (process.argv.includes('--strict-shots')) results.push(...sr);
  else console.log(`\n（商城四图：${ok}/${sr.length} 项通过；要判红绿请用 --strict-shots 或 --screenshots）`);
}

/* ── 汇总 ─────────────────────────────────────────────────── */
const failed = results.filter((x) => !x.ok);
for (const x of results) {
  console.log((x.ok ? '  OK   ' : '  FAIL ') + x.label + (x.detail && !x.ok ? `  << ${x.detail}` : ''));
}
console.log(`\n商城上架资料校验：PASS=${results.length - failed.length} FAIL=${failed.length}`);
if (failed.some((x) => x.label.includes('versions[0].version'))) {
  console.log('判读：索引版本与 package.json 不一致 —— 升版后忘了刷索引，最容易漏。');
}
if (failed.some((x) => x.label.includes('MAX_ICON_BYTES'))) {
  console.log('判读：图标超过 DSH 的 256 KiB 上限 → 插件元数据加载失败（icon exceeds 256 KiB）。');
}
if (failed.some((x) => x.label.includes('四角全透明'))) {
  console.log('判读：图标有白边 / 不是圆角透明 —— 商城小尺寸会露出方块角。');
}
process.exit(failed.length ? 1 : 0);
