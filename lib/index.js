/**
 * dsh-pet-restnow —— 歇会儿（RestNow）× 大肥鱼桌宠（dsh-pet）双向互动桥
 *
 * 设计要点（对应方案 v1.0）：
 *  - 桌宠侧：走 dsh-pet 已暴露的回环 HTTP `/dsh-pet-7340/*`（anim / broadcast / state），不修改桌宠源码。
 *  - 歇会儿侧：1.0.8.0 没有本机接口，因此只做「观察」——
 *      ① 轮询 config.json 识别番茄完成；② PowerShell 观察器识别全屏休息弹窗的起止。
 *  - 插件职责：事件归一化、动作映射、节流、去重、对账、可观测性。状态真值永远在各自应用里。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from './bridge-client.js';
import { WEB_FEATURE_GROUPS, publicFeatures, buildRunArgs, PANEL_HTML } from './web-panel.js';

export const name = 'dsh-pet-restnow';
export const inject = ['commands'];

const VERSION = '0.4.8';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WATCH_SCRIPT = join(PACKAGE_ROOT, 'assets', 'watch-restnow.ps1');
const PET_PREFIX = '/dsh-pet-7340';

// 休息态「弹窗已关但没收到 rest.dismissed」的兜底判据（见 Engine.observeBreakPopup）。
// 宽限期：弹窗刚建好 / SSE 补发的那一两帧可能量不到矩形，别当成已关闭。
const BREAK_GUARD_GRACE_MS = 1200;
// 纯几何推断需要连续两票、且跨过这个时间跨度，防止一次瞬时探测失败把鱼送回家。
const BREAK_GUARD_MIN_SAMPLES = 2;
const BREAK_GUARD_MIN_SPAN_MS = 900;

const DEFAULTS = {
  enabled: true,
  surface: 'desktop',
  petId: '',
  petPort: 0,
  bridgePort: 47110,
  watchWindows: true,
  pollMs: 2000,
  throttleMs: 10000,
  announceBreak: true,
  announcePomo: true,
  raisePetOnBreak: true,
  enablePetMenu: true,   // 右键桌宠 → 「更多」分组里的 RestNow 互动项（dsh-pet 原生 API，零改桌宠源码）
  // 右下角小卡被「取消 / × / Esc」关掉时，产品侧不广播 rest.dismissed；
  // 打开后由插件轮询 /v1/snapshot + timer.tick 兜底归位，关掉则回到「只认 dismiss」的旧行为。
  breakPopupGuard: true,
  autoLaunchRestNow: true, // 点动作时歇会儿没开 → 自动拉起再执行；关掉则维持旧行为（只提示）
  restnowLauncher: '',   // 显式指定启动入口（exe 绝对路径或 MSIX AppID）；留空=自动探测
  // 自动拉起时带 --startup：安装版/官网版会跳过主界面，root.after(60) 直接
  // withdraw 主窗 + tomato.show()，只留番茄钟在桌面；关掉则普通启动（会亮主界面）。
  launchTomatoOnly: true,
  // 桥刚就绪时番茄钟可能还在首帧摆位（_boot_to_tomato 排在 after(60)）；
  // 给一小段稳定期再下发用户点过的那条命令，避免状态被首帧初始化盖掉。
  launchSettleMs: 450,
  // Web 控制台：默认只绑本机；要手机/别的电脑访问需显式打开 webLan。
  webLan: false,
  webHost: '0.0.0.0',    // webLan=true 时的绑定地址
  webToken: '',          // 局域网必填的访问口令；留空则自动生成并打进 harness.log
  petTitle: 'dsh-pet',
  movePetOnBreak: true,
  petMoveCenterX: 0.5,
  petMoveBottomY: 0.54,
  // 优先走歇会儿 1.0.9+ 的本机桥（事件流 + 反向动作）；不可用时自动退回窗口观察器
  useBridge: true,
  // 陪工位：休息弹窗 / 番茄钟在用时，把桌宠挪到旁边陪着，不遮挡
  accompany: true,
  accompanyMode: 'spring',   // instant | spring | line（桌宠侧支持的三种移动方式）
  accompanyGap: 10,          // 桌宠与目标之间的最小间距（屏幕像素）——
                             // 小一点才像「站在卡片上沿」，28 看着离得远
  // /broadcast 带表情图（图名取自 dsh-pet /config 的 memes 表）
  memeImage: true,
};

/**
 * 动画名取自 dsh-pet 的 /config 与 assets/webm（均为真实存在的动画）。
 * ★ 休息动画必须跟台词同义 —— 两句台词写的都是「起来走两步 / 站起来动动」，
 *   原来配的 `原地小憩沉眠` / `深度睡眠` 是**鱼自己躺下睡**，
 *   和气泡里的字正好相反（跟「压力一只大肥鱼」那批图一个毛病）。
 */
const ANIM = {
  focus: '写代码',
  idle: '待机呼吸休闲',
  breakShort: '原地漂浮踏步',       // 「起来走两步」⇒ 原地踏步
  breakLong: '超大伸懒腰',          // 「肩颈都硬了」⇒ 伸懒腰
  back: '点击回应-开心跃动',
  celebrate: '三球抛接',
};

/**
 * 表情图名（`/broadcast` 的 `image` 字段）。
 * ★ 全部取自 dsh-pet `/config` 的 `memes` 表，不是自己编的。
 *   运行时还会与桌宠实际返回的列表核对一次，对不上就自动不带图（见 PetPort#_memeOk）。
 * ★ 选图标准：**图的梗要和场景同义**，不能只图热闹 ——
 *   曾经给「该歇会儿啦」配「压力一只大肥鱼」（冒汗喊压力），
 *   给「陪你缩番茄钟」配「誓死践行开源精神」（敬礼表态），
 *   用户反馈「内容不搭配场景」。这两张已经换掉。
 */
const MEME = {
  breakStart: '可爱',               // 正面卖萌：喊你起来动动
  // 长休息（≥5 分钟 / 强制）：原来配「死掉了」（翻肚皮灵魂出窍）——
  // 鱼自己躺平喊你起来动，视觉上自相矛盾，换「大的要来啦」（举喇叭喊话）。
  breakLong: '大的要来啦',
  breakEnd: 'Ciallo',               // 比耶：回来啦
  pomoDone: '厉害了我的鲸',          // 竖大拇指：干得漂亮
  focusStart: '',                   // 不带图（原「誓死践行开源精神」与「开干了」不搭）
  nearly: '大的要来啦',              // 举喇叭：快该歇了
  snoozed: '哦鲸鲸',                 // 死鱼眼「行吧行吧」：你先忙，到点再来喊
  // 「就骚了怎么滴吧」是叉腰嘴硬的梗，跟「这么快就坐回去了？起来走两步嘛」
  // 语义反向（嘴硬 = 我偏要），换成卖萌催促，跟台词同向。
  quickClose: '可爱',
  tomatoOn: '可爱',                 // 卖萌：在这儿陪你
  restarted: 'Ciallo',              // 比耶：加油
  restPraise: '吃饱饱摸肚子',        // 歇够了、很舒服：夸他爱护身体
};

/**
 * 台词原则：**全部是对「用户」说的**，催他起身活动、别久坐。
 * ★ 不要写成「鱼自己怎么着」（早先写过「鱼都躺平了」「那我再等等」）——
 *   用户反馈：那是鱼在休息，跟他没关系，反而带偏了提醒的本意。
 */
const TEXT = {
  breakStart: '该歇会儿啦，起来走两步',
  breakLong: '坐太久了，站起来动动，肩颈都硬了',
  breakEnd: '回来啦，伸个懒腰继续',
  quickClose: '这么快就坐回去了？起来走两步嘛',
  pomoDone: '一轮搞定！站起来活动一下 🎉',
  focusStart: '开干了，到点我喊你起来',
  snoozed: '你先忙，到点我再来喊你',
  tomatoOn: '缩好了，我在这儿陪你',
  restarted: '重新开始，这次也记得起来动动',
  // 歇够 5 分钟才用这句 —— 夸的是「他在爱护身体」，不是「他听话」
  restPraise: (mins) => `歇了 ${mins} 分钟，这才是真的在爱护自己`,
};

/**
 * 桌宠 /position 的坐标标定（实测，2560×1600 / cfg.size=462）。
 *   · x 就是「可见鱼中心」在屏幕宽度上的占比；
 *   · y 要先减掉一个随尺寸缩放的零点偏移，再按工作区高度归一 ——
 *     直接 y=0 会把鱼放到屏幕外，所以不能当纯比例用。
 * 复核方式：`_verify_seat.py`（截图差分求鱼的真实包围盒，断言不与目标矩形相交）。
 */
const PET_CAL = {
  wK: 0.502,      // 可见鱼宽 / cfg.size
  hK: 0.632,      // 可见鱼高 / cfg.size
  yBiasK: 0.169,  // y 归一化的零点偏移 / cfg.size
};

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  const line = `[dsh-pet-restnow] ${level} ${msg}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/* ------------------------------------------------------------------ *
 * 极简 HTTP 客户端（不依赖 fetch，超时可控）
 * ------------------------------------------------------------------ */

function httpJson({ port, path, method = 'GET', body, timeoutMs = 800, host = '127.0.0.1' }) {
  return new Promise((resolve) => {
    let payload;
    if (body !== undefined) {
      try {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
      } catch {
        resolve({ ok: false, error: 'body-not-serializable' });
        return;
      }
    }
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = httpRequest({ host, port, path, method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish({ ok: false, error: String(e && e.message ? e.message : e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 桌宠侧：dsh-pet 回环 HTTP
 * ------------------------------------------------------------------ */

class PetPort {
  constructor(cfg) {
    this.cfg = cfg;
    this.port = 0;
    this.petId = '';
    this.lastError = null;
    this.plays = 0;
    this.says = 0;
    this.moves = 0;
    this.failures = 0;
    this.petCfg = null;      // /config 的 main 段：尺寸、座位、表情图表都在这里
    this._rediscoverAt = 0;  // 重发现的节流（见 _maybeRediscover）
  }

  candidatePorts(hint) {
    const out = [];
    const push = (p) => {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
    };
    push(this.cfg.petPort);
    push(hint);
    // ★ 动态提示：桌宠（DSH）重启后端口可能变，静态的 cfg.petPort 就过期了。
    //   每次重发现都重新问一遍「现在的 webServer 在哪个端口」。
    try {
      if (typeof this.cfg.petHintPort === 'function') push(this.cfg.petHintPort());
    } catch {
      /* 提示函数炸了不影响别的候选 */
    }
    push(process.env.DSH_PET_PORT);
    push(43129);
    return out;
  }

  async discover(hintPort) {
    for (const port of this.candidatePorts(hintPort)) {
      const st = await httpJson({ port, path: `${PET_PREFIX}/state`, timeoutMs: 600 });
      if (!st.ok) continue;
      const cfg = await httpJson({ port, path: `${PET_PREFIX}/config`, timeoutMs: 800 });
      if (cfg.ok && cfg.json && cfg.json.main) this.petCfg = cfg.json.main;
      let petId = this.cfg.petId || '';
      if (!petId && cfg.ok && cfg.json && cfg.json.main) {
        const pets = Array.isArray(cfg.json.main.pets) ? cfg.json.main.pets : [];
        const desktop = pets.find((p) => String(p.display || '').includes('desktop'));
        const picked = desktop || pets[0];
        if (picked && picked.id) petId = String(picked.id);
      }
      this.port = port;
      this.petId = petId || 'main';
      this.lastError = null;
      log('info', 'pet discovered', { port, petId: this.petId });
      return true;
    }
    this.lastError = 'pet-not-found';
    return false;
  }

  async ensure() {
    if (this.port && this.petId) return true;
    return this.discover();
  }

  /**
   * 传输层失败 ⇒ 桌宠很可能重启过（DSH 更新、用户退出重开），端口已经变了。
   * 只有「HTTP 层都没答复」（没有 status）才算地址失效；4xx/5xx 说明地址是对的。
   */
  async _maybeRediscover(r) {
    if (r && (r.ok || r.status)) return false;
    // 节流：`livePos()` 每 2 秒问一次，桌宠彻底不在时不能每轮把候选端口全扫一遍
    const now = Date.now();
    if (now - (this._rediscoverAt || 0) < 5000) return false;
    this._rediscoverAt = now;
    this.port = 0;
    this.petId = '';
    this.petCfg = null;
    const ok = await this.discover();
    if (ok) log('info', 'pet rediscovered after failure', { port: this.port, petId: this.petId });
    else log('warn', 'pet rediscover failed', { error: this.lastError });
    return ok;
  }

  /** POST 到桌宠；地址失效时自动重发现并**重试一次**（这些动作本身都是幂等的）。 */
  async _post(pathFn, body, timeoutMs) {
    if (!(await this.ensure())) return { ok: false, error: 'pet-not-found' };
    let r = await httpJson({ port: this.port, path: pathFn(), method: 'POST', body, timeoutMs });
    if (r.ok && r.json) return r;
    if (await this._maybeRediscover(r)) {
      r = await httpJson({ port: this.port, path: pathFn(), method: 'POST', body, timeoutMs });
    }
    return r;
  }

  qs(extra = {}) {
    const q = new URLSearchParams();
    q.set('pet', this.petId || 'main');
    q.set('surface', this.cfg.surface || 'desktop');
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) q.set(k, String(v));
    return q.toString();
  }

  /** /config 里跟「坐在哪」「能放哪张表情」有关的那点信息。 */
  meta() {
    const m = this.petCfg && typeof this.petCfg === 'object' ? this.petCfg : {};
    const pets = Array.isArray(m.pets) ? m.pets : [];
    const me = pets.find((p) => String(p.id) === String(this.petId)) || pets[0] || {};
    const memes = m.memes && typeof m.memes === 'object' ? Object.keys(m.memes) : [];
    return {
      size: Number(me.size) > 0 ? Number(me.size) : 462,
      position: me.position && typeof me.position === 'object' ? me.position : null,
      memes,
      known: Boolean(this.petCfg),
    };
  }

  /**
   * 表情图名是否可用。
   * ★ 不同版本的桌宠 meme 表不一样：拿不到表时**放行**（best effort），
   *   拿到了就以桌宠为准 —— 别把自己写死的名字硬塞进去。
   */
  _memeOk(name) {
    if (!name) return false;
    const list = this.meta().memes;
    if (!list.length) return true;
    return list.includes(name);
  }

  async move(x, y, { mode = 'spring', timeoutMs = 1200 } = {}) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;   // 桌宠会 400
    if (!(await this.ensure())) return false;
    const r = await this._post(
      () => `${PET_PREFIX}/position?${this.qs()}`,
      { x: nx, y: ny, mode },
      timeoutMs,
    );
    if (!r.ok || !r.json || r.json.ok === false) {
      this.failures += 1;
      this.lastError = (r.json && r.json.message) || r.error || 'move-http-error';
      log('warn', 'pet move failed', { x: nx, y: ny, error: this.lastError, status: r.status });
      return false;
    }
    this.moves += 1;
    this.lastError = null;
    return true;
  }

  async play(animName, depth = 0) {
    if (!(await this.ensure())) return null;
    const r = await this._post(
      () => `${PET_PREFIX}/anim?${this.qs()}`,
      { name: animName },
      800,
    );
    if (!r.ok || !r.json) {
      this.failures += 1;
      this.lastError = r.error || 'play-http-error';
      log('warn', 'pet play failed', { animName, error: this.lastError, status: r.status });
      return null;
    }
    if (r.json.ok === false) {
      this.failures += 1;
      this.lastError = `${r.json.reason || 'unknown'}: ${r.json.message || ''}`;
      log('warn', 'pet play rejected', { animName, reason: r.json.reason, message: r.json.message });
      if (r.json.reason === 'unknown-animation' && depth === 0 && animName !== ANIM.idle) {
        return this.play(ANIM.idle, depth + 1);
      }
      return null;
    }
    this.plays += 1;
    this.lastError = null;
    return r.json.playbackId || null;
  }

  async say(text, { duration = 8000, anim = null, image = null } = {}) {
    if (!text) return false;
    if (!(await this.ensure())) return false;
    const body = { text, duration };
    if (anim) body.anim = anim;
    // 表情图：桌宠 `/config` 的 memes 表里有这一张才带
    if (image && this.cfg.memeImage !== false && this._memeOk(image)) {
      body.image = image;
    }
    const r = await this._post(() => `${PET_PREFIX}/broadcast?${this.qs()}`, body, 800);
    if (!r.ok || !r.json) {
      this.failures += 1;
      this.lastError = r.error || 'say-http-error';
      log('warn', 'pet say failed', { error: this.lastError, status: r.status });
      return false;
    }
    if (r.json.ok === false) {
      this.failures += 1;
      this.lastError = `${r.json.reason || 'unknown'}: ${r.json.message || ''}`;
      log('warn', 'pet say rejected', { reason: r.json.reason, message: r.json.message });
      return false;
    }
    this.says += 1;
    return true;
  }

  async state() {
    if (!(await this.ensure())) return null;
    let r = await httpJson({ port: this.port, path: `${PET_PREFIX}/state?${this.qs()}`, timeoutMs: 800 });
    if (!r.ok && await this._maybeRediscover(r)) {
      r = await httpJson({ port: this.port, path: `${PET_PREFIX}/state?${this.qs()}`, timeoutMs: 800 });
    }
    return r.ok ? r.json : null;
  }

  /**
   * 桌宠**此刻真实**的归一化坐标（走 `/state`，不是 `/config`）。
   *
   * ★ 为什么要它：`/config` 里 `pets[].position` 只有 `corner + margin`，
   *   是「用户没拖过时该待哪」，**不是**它现在在哪。
   *   用户手动把鱼拖到屏幕中间之后，按 corner 算出来的「家」还在右上角 ——
   *   休息结束鱼就飞回角落，用户看到的是「没回到原位」。
   *   `/state` 的 `pets[id].position.data.{x,y}` 才是拖动后的真位置。
   */
  // ── 第三方右键菜单（dsh-pet 原生 API，零改桌宠源码）─────────────
  // 项出现在桌宠右键上下文菜单的「更多」分组；点击由桌宠 POST 回 /menu/click。
  async registerMenu(owner, labels, target = 'desktop') {
    if (!(await this.ensure())) return false;
    const r = await httpJson({
      port: this.port,
      path: `${PET_PREFIX}/menu/item`,
      method: 'POST',
      body: { owner, labels, target },
      timeoutMs: 1000,
    });
    if (!r.ok || !r.json || r.json.ok === false) {
      this.lastError = (r.json && r.json.message) || r.error || 'menu-register-failed';
      return false;
    }
    return true;
  }

  async unregisterMenu(owner) {
    if (!this.port) return false;
    const r = await httpJson({
      port: this.port,
      path: `${PET_PREFIX}/menu/item?owner=${encodeURIComponent(owner)}`,
      method: 'DELETE',
      timeoutMs: 1000,
    });
    return Boolean(r.ok);
  }

  /**
   * 长轮询菜单点击事件。
   * - 成功：返回 `{ label: petId|null }` 映射（被点的项 petId 非 null）
   * - unknown-owner / 网络层失败：返回 `null`（调用方据此重注册）
   */
  async pollMenu(owner, waitMs = 30000) {
    if (!(await this.ensure())) return null;
    const w = Math.min(Math.max(0, Number(waitMs) || 0), 30000);
    const r = await httpJson({
      port: this.port,
      path: `${PET_PREFIX}/menu/events?owner=${encodeURIComponent(owner)}&wait=${w}`,
      method: 'GET',
      timeoutMs: w + 2000,
    });
    if (!r.ok) return null;
    const j = r.json || {};
    if (j.ok === false) return null;   // unknown-owner → 上层重注册
    return j.events || {};
  }

  async livePos() {
    const st = await this.state();
    const pets = st && st.pets;
    if (!pets) return null;
    const me = pets[this.petId] || pets[Object.keys(pets)[0]];
    const p = me && me.position && me.position.data;
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  snapshot() {
    return {
      port: this.port,
      petId: this.petId,
      plays: this.plays,
      says: this.says,
      moves: this.moves,
      failures: this.failures,
      lastError: this.lastError,
      size: this.meta().size,
      memes: this.meta().memes.length,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 歇会儿侧：配置文件观察
 * ------------------------------------------------------------------ */

function localAppData() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

/**
 * 找歇会儿的 `config.json`。
 *
 * ★ 这条路径不只是「读设置」用的：`bridge.json` **一定**和它同目录
 *   （`health_reminder._pick_data_dir()` 同时决定两者），所以找到它就等于
 *   找到桥的地址 —— 源码直跑 / 打包版 / MSIX 三种发行版一条逻辑全覆盖。
 *
 * ★ 取 mtime 最新的那个：机器上同时存在「商店版残留」和「源码在跑」时，
 *   谁在写谁的 mtime 就新，靠这个选活跃的那一个，而不是靠枚举顺序撞运气。
 */
function findRestNowConfig() {
  const cands = [];
  const packagesDir = join(localAppData(), 'Packages');
  if (existsSync(packagesDir)) {
    try {
      for (const d of readdirSync(packagesDir)) {
        if (!/^RestNow\./i.test(d)) continue;
        cands.push(join(packagesDir, d, 'LocalCache', 'Roaming', 'RestNow', 'config.json'));
        cands.push(join(packagesDir, d, 'LocalState', 'config.json'));
      }
    } catch {
      /* 目录不可读就跳过 */
    }
  }
  if (process.env.RESTNOW_CONFIG) cands.push(process.env.RESTNOW_CONFIG);
  cands.push(join(roamingAppData(), 'RestNow', 'config.json'));
  cands.push(join(localAppData(), 'RestNow', 'config.json'));

  let best = null;
  let bestT = -1;
  for (const p of cands) {
    try {
      const t = statSync(p).mtimeMs;
      if (t > bestT) {
        bestT = t;
        best = p;
      }
    } catch {
      /* 这个候选不存在 */
    }
  }
  return best;
}

class RestNowProbe {
  constructor(cfg) {
    this.cfg = cfg;
    // cfg.configPath 可显式指定（排障 / 回归脚本把数据目录指到别处）
    this.configPath = cfg.configPath || findRestNowConfig();
    this.lastError = null;
  }

  read() {
    if (!this.configPath) this.configPath = findRestNowConfig();
    if (!this.configPath) return null;
    try {
      const json = JSON.parse(readFileSync(this.configPath, 'utf8'));
      const mtime = statSync(this.configPath).mtimeMs;
      return { json, mtime };
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      return null;
    }
  }

  snapshot() {
    const r = this.read();
    if (!r) return null;
    const j = r.json;
    const items = Array.isArray(j.pomo_log) ? j.pomo_log : [];
    const last = items.length ? items[items.length - 1] : null;
    return {
      mtime: r.mtime,
      configPath: this.configPath,
      intervalMin: Number(j.interval_minutes) || 0,
      popupSec: Number(j.popup_duration_seconds) || 0,
      forceRest: j.force_rest === true,
      statCount: Number(j.stat_count) || 0,
      pomoCount: items.length,
      lastPomoTs: last && Number(last.ts) ? Number(last.ts) : 0,
      lastPomo: last,
      theme: typeof j.theme === 'string' ? j.theme : '',
      tomatoTheme: typeof j.tomato_theme === 'string' ? j.tomato_theme : '',
      statDate: typeof j.stat_date === 'string' ? j.stat_date : '',
    };
  }
}

/* ------------------------------------------------------------------ *
 * 歇会儿侧：休息弹窗观察器（PowerShell 子进程）
 * ------------------------------------------------------------------ */

function findPwsh() {
  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'powershell.exe';
}

/**
 * 找到「歇会儿」主进程的 pid（观察器要用它枚举窗口）。
 *
 * ★ 顺序有讲究：
 *   ① 桥上报的 pid 最可靠 —— `bridge.json` 里就写着启动它的那个进程 id，
 *      商店版、源码版、打包 exe 版全都通用。**先试这个**，不 exec 任何东西。
 *   ② 商店版进程名固定在 `RestNow`（MSIX 里就叫这个）。
 *   ③ 源码直跑时进程名是 `pythonw` / `HealthReminder`，只能靠命令行认出
 *      `health_reminder.py` —— 早期只做 ②，于是源码版永远 `not-running`
 *      ⇒ ZGuard 起不来 ⇒ 全屏遮罩把桌宠压暗（2026-11-07 实测）。
 */
function findRestNowPid(hintPid = 0) {
  const hinted = Number(hintPid) || 0;
  if (hinted > 0) return Promise.resolve(hinted);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let ps;
    try {
      ps = spawn(findPwsh(), [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        // ① 商店版 / 打包 exe：进程名固定，有主窗口的那个才是真的
        'Get-Process -Name RestNow,HealthReminder -ErrorAction SilentlyContinue | ' +
          'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id; ' +
          // ② 源码直跑：进程名是 pythonw / python，只能靠命令行认 health_reminder.py。
          //   注意 venv 的 pythonw 会再拉一个子进程，两个命令行一模一样 ——
          //   挑有 MainWindowHandle 的那个（Tk 主窗口在那儿）。
          "$c = @(Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\" " +
          '-ErrorAction SilentlyContinue | ' +
          'Where-Object { $_.CommandLine -like "*health_reminder.py*" } | ' +
          'Select-Object -ExpandProperty ProcessId); ' +
          'if ($c.Count -gt 0) { ' +
          '$w = Get-Process -Id $c -ErrorAction SilentlyContinue | ' +
          'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id; ' +
          'if ($w) { $w } else { $c[0] } }',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      done(0);
      return;
    }
    let out = '';
    ps.stdout.on('data', (c) => (out += c.toString('utf8')));
    ps.on('error', () => done(0));
    ps.on('exit', () => {
      const first = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .find((n) => Number.isFinite(n) && n > 0);
      done(first || 0);
    });
    setTimeout(() => {
      try {
        ps.kill();
      } catch {}
      done(0);
    }, 6000);
  });
}

/* ------------------------------------------------------------------ *
 * 自动拉起歇会儿：右键菜单点了个动作、但歇会儿没开时先帮用户启动再执行
 * ------------------------------------------------------------------ */

const LAUNCH_OPTS = { detached: true, stdio: 'ignore', windowsHide: true };
export const STARTUP_ARG = '--startup';

/**
 * 把「启动入口」翻译成真正要 spawn 的命令行。
 *
 * ★ 只有经典 EXE / 官网版能收命令行参数：产品入口读到 `--startup` 后
 *   `startup=True` ⇒ 不调 `_show_main_synced()`，
 *   `root.after(60, _boot_to_tomato)` ⇒ `root.withdraw()` + `tomato.show()`，
 *   于是「只出番茄钟、不显示主界面」。
 * ★ MSIX 商店版必须走 `explorer.exe shell:AppsFolder\<AppID>`，Explorer **不转发**
 *   参数；产品侧的 `<uap5:StartupTask>` 只由系统开机触发，第三方拉不起来。
 *   所以这一路如实返回 `degraded=true`，由上层明确告知用户，绝不假装已经静默进番茄钟。
 * ★ 抽成纯函数是为了让 smoke 直接断言 argv，而不是靠「看日志猜有没有传参」。
 */
export function buildLaunchCommand(launcher, { tomatoOnly = true } = {}) {
  if (!launcher || !launcher.target) return null;
  const want = Boolean(tomatoOnly);
  if (launcher.kind === 'appid') {
    return {
      command: 'explorer.exe',
      args: [`shell:AppsFolder\\${launcher.target}`],
      opts: LAUNCH_OPTS,
      tomatoOnly: false,
      degraded: want,
      reason: 'msix-no-args',
    };
  }
  return {
    command: launcher.target,
    args: want ? [STARTUP_ARG] : [],
    opts: { ...LAUNCH_OPTS, cwd: dirname(launcher.target) },
    tomatoOnly: want,
    degraded: false,
    reason: want ? 'exe-startup-arg' : 'exe-normal',
  };
}

/** 启动后第一次下发动作允许重试的类型（幂等），toggle_pause / quit 重发会翻两次。 */
const RETRY_SAFE_ACTIONS = new Set(['start_focus', 'snooze', 'rest_now', 'set_config']);

/**
 * 生成「一次查全本机启动入口」的 PowerShell 脚本。
 * ★★ 每个数组元素必须是**一条完整语句**：它们用 `; ` 拼接。
 *    1.4.4 把 `@('A',` / `'B',` / `'C')` 拆成三个元素 ⇒ 拼出
 *    `$roots = @('A',; 'B',; 'C')` ⇒ PowerShell 解析失败、stdout 全空、
 *    stderr 又被丢弃 ⇒ 恒判「未安装」，真机日志 `launch: restnow not installed`。
 *    现在 $roots 一行写完，语句之间才用 `; `。
 * ★ 抽成纯函数是为了让回归测试能直接断言脚本结构（`smoke-launch.mjs`），
 *   别再靠「复制一份脚本到探针」—— 那种复制品会腐烂成假绿。
 * 输出最多三行：EXE=...（安装版）/ APPID=...（MSIX）/ FALLBACK=...（默认安装目录）。
 */
export function buildLaunchProbeScript() {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    // 放宽到前缀匹配，且跳过 DisplayIcon 为空的「歇会儿探针」等附属项
    "$u = @(Get-ItemProperty $roots | Where-Object { $_.DisplayName -like '歇会儿*' -and $_.DisplayIcon } | Select-Object -First 1 -ExpandProperty DisplayIcon)",
    "if ($u.Count -gt 0 -and $u[0]) { 'EXE=' + ($u[0] -replace ',\\s*\\d+$','') }",
    // 安装版在 Get-StartApps 里的 AppID 是**文件路径**（不含 !），只有 MSIX 商店版才带 !
    "$s = @(Get-StartApps | Where-Object { $_.AppID -like '*!*' -and $_.Name -like '歇会儿*' } | Select-Object -First 1 -ExpandProperty AppID)",
    "if ($s.Count -gt 0 -and $s[0]) { 'APPID=' + $s[0] }",
    "$p = Join-Path $env:LOCALAPPDATA 'RestNow\\RestNow.exe'",
    "if (Test-Path $p) { 'FALLBACK=' + $p }",
  ].join('; ');
}

/** 用 -EncodedCommand（UTF-16LE）传脚本：绕开 -Command 下中文 + 多层引号的转义地狱。 */
function probeRestNowLaunchers() {
  const encoded = Buffer.from(buildLaunchProbeScript(), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, err = '') => {
      if (settled) return;
      settled = true;
      if (err) log('warn', 'launch probe: powershell failed', { stderr: err.slice(0, 400) });
      resolve(v);
    };
    let ps;
    try {
      // ★ stderr 不能丢：脚本一旦写错，否则又是「静默的未安装」
      ps = spawn(findPwsh(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({}, String(e && e.message ? e.message : e));
      return;
    }
    let out = '', err = '';
    ps.stdout.on('data', (c) => (out += c.toString('utf8')));
    ps.stderr.on('data', (c) => (err += c.toString('utf8')));
    ps.on('error', (e) => done({}, String(e && e.message ? e.message : e)));
    ps.on('exit', () => {
      const r = {};
      for (const line of out.split(/\r?\n/)) {
        const m = /^(EXE|APPID|FALLBACK)=(.+)$/.exec(line.trim());
        if (m) r[m[1]] = m[2].trim().replace(/^"|"$/g, '');
      }
      done(r, Object.keys(r).length ? '' : err);
    });
    setTimeout(() => { try { ps.kill(); } catch {} done({}, 'probe timeout'); }, 8000);
  });
}

/** 选中该拉起哪一个：活跃 config 落在 Packages\RestNow.* ⇒ 商店版优先，否则安装版优先。 */
async function resolveRestNowLauncher(cfg, configPath, probeFn = probeRestNowLaunchers) {
  const explicit = String(cfg.restnowLauncher || '').trim();
  if (explicit) {
    if (explicit.includes('!') || /^shell:/i.test(explicit)) {
      return { kind: 'appid', target: explicit.replace(/^shell:AppsFolder\\/i, '') };
    }
    return { kind: 'exe', target: explicit };
  }
  const found = await probeFn();
  const store = /[\\/]Packages[\\/]RestNow\./i.test(String(configPath || ''));
  const pickExe = () => {
    const p = (found.EXE || found.FALLBACK || '').replace(/^"|"$/g, '');
    return p && existsSync(p) ? { kind: 'exe', target: p } : null;
  };
  const pickAppId = () => (found.APPID ? { kind: 'appid', target: found.APPID } : null);
  return store ? (pickAppId() || pickExe()) : (pickExe() || pickAppId());
}

class WindowWatcher {
  constructor(engine) {
    this.engine = engine;
    this.child = null;
    this.targetPid = 0;
    this.retryTimer = null;
    this.stopped = false;
    this.startedAt = null;
    this.lastEvent = null;
  }

  async start(raiseOnly = false) {
    if (this.stopped || this.child) return;
    this.raiseOnly = Boolean(raiseOnly);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // 桥已经知道主程序 pid（bridge.json 里就有）——直接用它，别靠进程名猜。
    const pid = await findRestNowPid(this.engine.bridge.pid);
    if (!pid) {
      this.scheduleRetry('restnow-not-running');
      return;
    }
    if (!existsSync(WATCH_SCRIPT)) {
      log('warn', 'watcher script missing', { WATCH_SCRIPT });
      return;
    }
    this.targetPid = pid;
    const psExe = findPwsh();
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WATCH_SCRIPT,
      '-TargetPid',
      String(pid),
      '-ParentPid',
      String(process.pid),
      '-IntervalMs',
      '300',
      '-RaisePet',
      this.engine.cfg.raisePetOnBreak ? '1' : '0',
      '-MoveOnBreak',
      // 桥模式下座位由插件自己算（知道卡片矩形），watcher 只管把弹窗压到桌宠下面
      this.raiseOnly ? '0' : (this.engine.cfg.movePetOnBreak ? '1' : '0'),
      '-PetTitle',
      String(this.engine.cfg.petTitle || 'dsh-pet'),
      '-PetApiPort',
      String(this.engine.pet.port || this.engine.cfg.petPort || 43129),
      '-PetId',
      String(this.engine.pet.petId || 'main'),
      '-TargetCenterX',
      String(this.engine.cfg.petMoveCenterX ?? 0.5),
      '-TargetBottomY',
      String(this.engine.cfg.petMoveBottomY ?? 0.54),
    ];
    let child;
    try {
      child = spawn(psExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log('warn', 'watcher spawn failed', { error: String(e && e.message ? e.message : e) });
      return;
    }
    this.child = child;
    this.startedAt = nowIso();
    log('info', 'window watcher started', { targetPid: pid, ps: psExe });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      // ★ 只清自己：`restart()` 会在旧进程退出前就先起一个新的，
      //   无条件 `this.child = null` 会把**新**的那个句柄抹掉 ——
      //   之后 stop() 杀不到它，scheduleRetry 又会再起一个，越叠越多。
      if (this.child === child) {
        this.child = null;
        log('warn', 'window watcher exited', { code });
        if (!this.stopped) this.scheduleRetry('watcher-exit');
      }
    });
    child.on('error', (e) => {
      log('warn', 'window watcher error', { error: String(e && e.message ? e.message : e) });
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    this.lastEvent = { ...msg, at: nowIso() };
    if (msg.type === 'break') {
      // raiseOnly（桥模式）：「弹窗出现」由 SSE 的 rest.shown 驱动，这里再回调会坐两次，跳过。
      // 但「弹窗窗口已关」(active=false) 是 SSE 的 rest.dismissed 漏掉时的兜底归位信号，必须放行 ——
      // 否则一次丢包就会让 breakActive 永远卡 true，鱼再也不归位（2026-11-07 反馈 #2）。
      if (this.raiseOnly && msg.active) return;
      this.engine.onBreak(Boolean(msg.active), { w: msg.w, h: msg.h, raised: msg.raised, source: 'window' });
    } else if (msg.type === 'moved') {
      log('info', 'pet repositioned by watcher', { result: msg.result, rect: msg.rect });
    } else if (msg.type === 'gone') {
      this.engine.onRestNowGone();
      this.scheduleRetry('restnow-exited');
    } else if (msg.type === 'error') {
      log('warn', 'watcher error', { message: msg.message });
    }
  }

  scheduleRetry(reason) {
    if (this.stopped || this.retryTimer || this.child) return;
    this.pendingReason = reason;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || this.child) return;
      this.start().catch(() => {});
    }, 5000);
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }

  /**
   * 换模式重启（桥连上 / 断开时在 raiseOnly 与完整模式之间切）。
   * ★ 必须显式把 `stopped` 解开 —— `stop()` 是给 `engine.stop()` 收尾用的，
   *   它把 `stopped` 设成 true，而 `start()` 第一行就 `if (this.stopped) return`
   *   ⇒ 以前 `onBridgeDown` 里那套 `stop()` + `setTimeout(start)` **根本起不来**，
   *   watcher 一辈子停在旧模式（2026-11-07 发现）。
   */
  async restart(raiseOnly) {
    this.stop();
    this.stopped = false;
    await this.start(Boolean(raiseOnly));
  }

  snapshot() {
    return {
      running: Boolean(this.child),
      targetPid: this.targetPid,
      startedAt: this.startedAt,
      lastEvent: this.lastEvent,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 陪工位：把桌宠挪到目标旁边，保证不遮挡
 * ------------------------------------------------------------------ */

function overlaps(a, b, pad = 0) {
  if (!a || !b) return false;
  return !(a.x + a.w + pad <= b.x || a.x >= b.x + b.w + pad
    || a.y + a.h + pad <= b.y || a.y >= b.y + b.h + pad);
}

class Seat {
  constructor(engine) {
    this.engine = engine;
    this.home = null;      // 首次挪动前记下的「原位」（归一化坐标）
    this.at = null;        // 当前被我们放到的位置；null = 在原来该在的地方
    this.why = '';         // 为了谁坐过去的：rest / focus
    this.seatedAt = 0;
    this.lastTarget = null;
  }

  /**
   * 屏幕像素 ↔ 桌宠 /position 归一化坐标。
   * ★ 鱼的中心不是屏幕比例的直映射：y 要先扣掉一个随尺寸缩放的零点偏移，
   *   否则 y=0 会把鱼放到屏幕外（见 PET_CAL 注释）。
   */
  _frame(geo, meta) {
    const sc = (geo && geo.screen) || {};
    const sw = Number(sc.w) || 2560;
    const workH = Number(sc.workH) || Number(sc.h) || 1600;
    const workTop = Number(sc.workTop) || 0;
    const size = Number(meta.size) || 462;
    const bias = size * PET_CAL.yBiasK;
    const pw = Math.max(24, Math.round(size * PET_CAL.wK));
    const ph = Math.max(24, Math.round(size * PET_CAL.hK));
    // 可见本体必须整个落在工作区里
    const xMin = pw / 2 / sw;
    const xMax = 1 - pw / 2 / sw;
    const yMin = (ph / 2 - bias) / workH;
    const yMax = (workH - ph / 2 - bias) / workH;
    return {
      sw, workH, workTop, bias, pw, ph,
      toNorm: (cx, cy) => ({
        x: Math.min(xMax, Math.max(xMin, cx / sw)),
        y: Math.min(yMax, Math.max(yMin, (cy - workTop - bias) / workH)),
      }),
    };
  }

  /**
   * 桌宠的「家」。
   *
   * ★ 优先用**用户手动拖到的最后位置**（`/state` 的实时坐标）。
   *   老实现只按 `/config` 的 `corner + margin` 反算 —— 用户拖过鱼之后，
   *   那个角落早就不是它待的地方了，休息结束鱼会飞回右上角，
   *   用户看到的就是「关掉弹窗鱼没回到原位」（2026-11-07 反馈）。
   *   corner 只当拿不到实时坐标时的兜底。
   */
  _ensureHome(meta, g) {
    if (this.home) return this.home;
    const p = meta.position || {};
    const liveX = Number(p.x);
    const liveY = Number(p.y);
    if (Number.isFinite(liveX) && Number.isFinite(liveY)
      && liveX >= 0 && liveX <= 1 && liveY >= 0 && liveY <= 1) {
      this.home = { x: liveX, y: liveY };
      return this.home;
    }
    const corner = String(p.corner || 'top-right').toLowerCase();
    const mx = Number(p.marginX) || 0;
    const my = Number(p.marginY) || 0;
    const cx = corner.includes('right') ? g.sw - mx - g.pw / 2 : mx + g.pw / 2;
    const cy = corner.includes('bottom')
      ? g.workTop + g.workH - my - g.ph / 2
      : g.workTop + my + g.ph / 2;
    this.home = g.toNorm(cx, cy);
    return this.home;
  }

  /** 在目标四周找第一个「装得下、不压到任何禁区、离目标最近」的落点。 */
  _spot(rect, forbidden, g, gap) {
    const t = rect;
    const cx0 = t.x + t.w / 2;
    const cy0 = t.y + t.h / 2;
    const right = t.x + t.w + gap + g.pw / 2;
    const left = t.x - gap - g.pw / 2;
    const below = t.y + t.h + gap + g.ph / 2;
    const above = t.y - gap - g.ph / 2;
    const cands = [
      { cx: right, cy: cy0 }, { cx: left, cy: cy0 },
      { cx: cx0, cy: below }, { cx: cx0, cy: above },
      { cx: left, cy: below }, { cx: right, cy: below },
      { cx: left, cy: above }, { cx: right, cy: above },
    ];
    const pad = 6;
    const loX = pad;
    const loY = g.workTop + pad;
    const hiX = g.sw - pad;
    const hiY = g.workTop + g.workH - pad;
    let best = null;
    for (const c of cands) {
      const box = { x: c.cx - g.pw / 2, y: c.cy - g.ph / 2, w: g.pw, h: g.ph };
      if (box.x < loX || box.y < loY || box.x + box.w > hiX || box.y + box.h > hiY) continue;
      if (forbidden.some((f) => overlaps(box, f, pad))) continue;
      // 「站在目标上面」优先：视觉上就是踩在卡片 / 小窗的上沿，也最不挡内容。
      // 其余位置仍保留「别跑到屏幕上半截」的惩罚，免得挡住状态栏和菜单。
      const above = c.cy < cy0;
      const score = Math.hypot(c.cx - cx0, c.cy - cy0)
        + (above ? -400 : 0)
        + (c.cy < g.workTop + g.workH * 0.45 && !above ? 500 : 0);
      if (!best || score < best.score) best = { cx: c.cx, cy: c.cy, score, box };
    }
    return best;
  }

  /**
   * 坐到 `rect` 旁边。
   * @param {string} kind  rest | focus
   * @param {{x,y,w,h}|null} rect 目标矩形（屏幕像素）
   * @param {Array} extra 额外的禁区矩形
   */
  async sitBeside(kind, rect, extra = [], { force = false } = {}) {
    const cfg = this.engine.cfg;
    if (!cfg.accompany) return null;
    if (!rect || !(Number(rect.w) > 8) || !(Number(rect.h) > 8)) return null;
    const geo = await this.engine.geo(force);
    if (!geo || !geo.screen) {
      log('info', 'seat: 没有几何信息（歇会儿 1.0.9 以下 / 桥不可用），跳过', { kind });
      return null;
    }
    // 全屏休息界面铺满整个屏幕 —— 躲到哪都挡住它，干脆别动（鱼就守在屏幕上）
    const sc = geo.screen || {};
    const screenArea = (Number(sc.w) || 0) * (Number(sc.h) || 0);
    if (screenArea > 0 && Number(rect.w) * Number(rect.h) >= screenArea * 0.85) {
      log('info', 'seat: 目标占满整屏，无处可躲，保持原位', { kind });
      return null;
    }
    // ★ 去重：同一轮休息里 rest.shown 可能被重复广播（SSE 重连补发 / 抖动 / 自愈误判），
    //   鱼已经坐在这附近了就别再挪 —— 每次挪动都会让 Electron 透明窗重新合成，
    //   重复挪动就是肉眼可见的「鱼闪一下」。坐标没变就直接复用上次结果。
    if (!force && this.at && this.why === kind && this.lastTarget
      && Math.abs((rect.x || 0) - (this.lastTarget.x || 0)) < 40
      && Math.abs((rect.y || 0) - (this.lastTarget.y || 0)) < 40
      && Math.abs((rect.w || 0) - (this.lastTarget.w || 0)) < 40
      && Math.abs((rect.h || 0) - (this.lastTarget.h || 0)) < 40) {
      log('info', 'seat: 已在同目标旁落座，跳过重复挪动', { kind });
      return { ok: true, ...this.at, kind, skipped: true };
    }
    const meta = this.engine.pet.meta();
    const g = this._frame(geo, meta);
    // ★ 落座**之前**再抓一次真实位置。只看 poll（2 秒一次）会有个缝：
    //   用户刚把鱼拖走就弹提醒，这一轮会拿旧坐标当家 ⇒ 收窗又飞回老地方。
    //   这里补一次同步抓取，拖完立刻弹也不会丢。
    await this.syncHome();
    this._ensureHome(meta, g);
    // 禁区里的「弹窗」要用**卡片**，不能用整屏遮罩 —— 否则全屏时每个候选位
    // 都与遮罩相交，永远找不到座位。目标自己也不算禁区。
    const same = (a, b) => Boolean(a && b && a.x === b.x && a.y === b.y
      && a.w === b.w && a.h === b.h);
    const forbidden = [...extra, geo.popup_card || geo.popup, geo.tomato]
      .filter((r) => r && r.w > 8 && r.h > 8 && !same(r, rect));
    const gap = Number(cfg.accompanyGap) || 28;
    const spot = this._spot(rect, forbidden, g, gap);
    if (!spot) {
      log('info', 'seat: 四周没有不遮挡的空位，保持原位', { kind });
      return null;
    }
    const n = g.toNorm(spot.cx, spot.cy);
    const ok = await this.engine.pet.move(n.x, n.y, { mode: cfg.accompanyMode || 'spring' });
    if (!ok) return null;
    this.at = n;
    this.why = kind;
    this.lastTarget = rect;
    this.seatedAt = Date.now();
    this.engine.stats.seats += 1;
    log('info', 'pet seated', { kind, x: +n.x.toFixed(4), y: +n.y.toFixed(4) });
    return { ok: true, ...n, kind };
  }

  /** 番茄钟被拖走时才跟着挪 —— 不拖就不动，别让桌宠满屏乱跑。 */
  async reseatIfMoved(rect) {
    if (!this.at || this.why !== 'focus') return null;
    if (!rect || !this.lastTarget) return null;
    const d = Math.abs(rect.x - this.lastTarget.x) + Math.abs(rect.y - this.lastTarget.y);
    if (d < 40) return null;
    return this.sitBeside('focus', rect, [], { force: true });
  }

  /**
   * 空闲时把「家」刷新成桌宠此刻的真实位置 —— 用户在拖鱼，家就跟着走。
   *
   * ★ 只在**没陪着工位**的时候刷：坐着的时候那个坐标是我们摆的，
   *   拿它当「家」会让鱼再也回不去（越坐越偏）。
   */
  /**
   * 空闲时把「家」刷新成桌宠此刻的真实位置 —— 用户在拖鱼，家就跟着走。
   *
   * ★ 2026-11-07 修正（用户反馈 #2：鱼本来在右上角，关窗却飞到左上角）：
   *   旧实现用 `/state` 的 `position.data` 反推「家」，但实测该字段**恒为 {x:0,y:0}**，
   *   并不随鱼真实位置更新；用它当 home 会把鱼归位到左上角。
   *   所以「家」不再从 livePos 取，统一由 `_ensureHome` 按 /config 的
   *   `corner + margin` 计算 —— 即桌宠配置里「停靠角」，正是用户期望的归位点。
   */
  async syncHome() {
    return;
  }

  /** 回原位。 */
  async restore(reason = '') {
    if (!this.at) return false;
    const home = this.home;
    this.at = null;
    this.why = '';
    this.lastTarget = null;
    if (!home) return false;
    // ★ 归位过程中不要再抓 home：`at` 已经清了，这期间鱼的坐标还是**坐着**的
    //   那个，谁要是刷一次 syncHome 就会把「家」改成弹窗旁边 ——
    //   下一次休息结束就再也回不去了。
    this._restoring = true;
    try {
      const ok = await this.engine.pet.move(home.x, home.y,
        { mode: this.engine.cfg.accompanyMode || 'spring' });
      if (ok) {
        log('info', 'pet restored', {
          reason, x: +home.x.toFixed(4), y: +home.y.toFixed(4),
        });
      }
      return ok;
    } finally {
      this._restoring = false;
      this.home = home;          // 万一中途被覆盖，也要还原
    }
  }

  snapshot() {
    return {
      at: this.at,
      home: this.home,
      why: this.why,
      seatedAt: this.seatedAt || null,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 场景引擎
 * ------------------------------------------------------------------ */

class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.pet = new PetPort(cfg);
    this.probe = new RestNowProbe(cfg);
    this.watcher = new WindowWatcher(this);
    this.bridge = new BridgeClient(cfg, {
      onEvent: (evt) => this.onBridgeEvent(evt),
      onDown: () => this.onBridgeDown(),
      onUp: () => this.onBridgeUp(),
      // 桥客户端靠它推导 `bridge.json` 的位置（见 findRestNowConfig 的注释）
      getConfigPath: () => this.probe.configPath,
      log,
    });
    this.bridgeMode = false;
    this.restnowPaused = false;
    this.muted = false;
    this.breakActive = false;
    this.lastBreakAt = null;
    this.lastBreakStartAt = 0;   // 最近一次进入休息的时间戳（自愈判定用）
    this.lastBreakEndAt = 0;
    this.lastActionAt = new Map();
    this.stats = {
      breakStarts: 0, breakEnds: 0, pomoCompleted: 0,
      breakPopupGuard: 0,   // 小卡手动关闭、产品没发 rest.dismissed 时兜底归位的次数
      actions: 0, skipped: 0, bridgeActions: 0, seats: 0,
      longRests: 0,          // 歇够 5 分钟的次数（夸过几次）
    };
    this.lastSnapshot = null;
    this.pollTimer = null;
    this.bridgeWatchTimer = null;   // 桥没连上时的重探节拍（独立于 poll）
    this.bridgeTries = 0;
    this.bridgeWatchStopped = false;
    this.startedAt = nowIso();
    this.seat = new Seat(this);
    this.lastGeo = null;     // 最近一次拿到的几何（事件里带来的 / 主动拉的）
    this.geoAt = 0;
    // 右键菜单（桌宠「更多」分组）项 → RestNow 动作；点谁触发谁
    this.MENU_OWNER = 'restnow-bridge';
    this.MENU_ACTIONS = {
      '立即休息': { type: 'rest_now' },
      '开始专注25min(番茄钟)': { type: 'start_focus', minutes: 25 },
      '开始专注35min(番茄钟)': { type: 'start_focus', minutes: 35 },
      '开始专注45min(番茄钟)': { type: 'start_focus', minutes: 45 },
      '暂停/恢复提醒': { type: 'toggle_pause' },
      '延后5分钟': { type: 'snooze', minutes: 5 },
    };
    this._menuStop = true;
    this._menuLoopRunning = false;
    this._launching = null;   // 同一时刻只允许一次「拉起歇会儿」
    this.launchDeps = null;   // 测试替身：{ findPid, resolveLauncher, spawn }
    // 休息态弹窗守卫：连续观测到「弹窗没了」的票数与起始时刻
    this.breakGuardStreak = 0;
    this.breakGuardSince = 0;
    this._breakProbeBusy = false;
  }

  /** 每次休息状态变化时清空兜底票数，避免上一轮的观测串到新一轮。 */
  resetBreakGuard() {
    this.breakGuardStreak = 0;
    this.breakGuardSince = 0;
  }

  /** 记下事件里带来的几何，供陪工位即时使用（不额外发一次请求）。 */
  ingestGeo(geo) {
    if (geo && geo.screen) {
      this.lastGeo = geo;
      this.geoAt = Date.now();
    }
    return this.lastGeo;
  }

  /** 拿几何：优先用事件里带的，其次拉一次 /v1/snapshot。 */
  async geo(force = false) {
    if (!force && this.lastGeo && Date.now() - this.geoAt < 5000) return this.lastGeo;
    try {
      const snap = await this.bridge.snapshotDeep();
      if (snap && snap.screen) {
        this.lastGeo = snap;
        this.geoAt = Date.now();
      }
    } catch {
      /* 拿不到就沿用旧的 */
    }
    return this.lastGeo;
  }

  async start() {
    log('info', 'engine start', { version: VERSION, surface: this.cfg.surface });
    const snap = this.probe.snapshot();
    this.lastSnapshot = snap;
    if (!snap) {
      log('warn', 'restnow config not found', { path: this.probe.configPath });
    } else {
      log('info', 'restnow config loaded', {
        path: snap.configPath,
        intervalMin: snap.intervalMin,
        popupSec: snap.popupSec,
        pomoCount: snap.pomoCount,
      });
    }
    await this.pet.discover();
    // 有本机桥就用事件流（精确到毫秒、能拿反向控制），否则退回窗口观察器。
    if (this.cfg.useBridge) {
      try {
        if (await this.bridge.probe()) {
          this.bridgeMode = true;
          this.bridge.start();
          log('info', 'bridge mode on（事件流驱动；窗口观察器降级为只做置顶守卫）', {
            port: this.bridge.port,
            restnow: this.bridge.appVersion,
          });
        }
      } catch (e) {
        log('warn', 'bridge probe failed', { error: String((e && e.message) || e) });
      }
    }
    // ★ 不管这次连没连上，都要把「重探节拍」臂上：
    //   歇会儿可能比 DSH 晚开、可能中途重装/重启（端口和 token 每次都变）。
    this.armBridgeWatch(this.bridgeMode ? 8000 : 300);
    this.pollTimer = setInterval(() => this.poll(), this.cfg.pollMs || 2000);
    if (this.cfg.watchWindows) {
      // 桥模式下**也要起** —— 它此时唯一的职责是「把全屏弹窗压回桌宠下面」，
      // 不再由它推算休息状态（那是 SSE 的活），也不由它挪鱼（座位由插件算）。
      // 否则全屏遮罩 alpha 0.97 会把站在卡片上方的鱼整只压暗。
      this.watcher.start(this.bridgeMode).catch(() => {});
    }
    if (this.cfg.enablePetMenu) {
      this.runMenuLoop().catch((e) => log('error', 'pet menu loop crashed', { error: String((e && e.message) || e) }));
    }
  }

  stop() {
    this.bridgeWatchStopped = true;
    if (this.bridgeWatchTimer) {
      clearTimeout(this.bridgeWatchTimer);
      this.bridgeWatchTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      this.bridge.stop();
    } catch {
      /* ignore */
    }
    if (this.cfg.enablePetMenu) this.stopMenuLoop();
    this.watcher.stop();
  }

  // ── 右键菜单（dsh-pet 原生 API）──────────────────────────────────
  async registerPetMenu() {
    if (!this.cfg.enablePetMenu) return false;
    const ok = await this.pet.registerMenu(this.MENU_OWNER, Object.keys(this.MENU_ACTIONS), 'desktop');
    if (ok) log('info', 'pet menu registered', { owner: this.MENU_OWNER, items: Object.keys(this.MENU_ACTIONS) });
    else log('warn', 'pet menu register failed', { error: this.pet.lastError });
    return ok;
  }

  /** 长轮询点击事件；unknown-owner/网络失败就重注册，保证桌宠重启后自愈。 */
  async runMenuLoop() {
    if (!this.cfg.enablePetMenu || this._menuLoopRunning) return;
    this._menuLoopRunning = true;
    this._menuStop = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 先尽量注册上（桌宠还没就绪时 poll 会拿 unknown-owner，循环里会自动重注册）
    await this.registerPetMenu();
    while (!this._menuStop) {
      try {
        const events = await this.pet.pollMenu(this.MENU_OWNER, 30000);
        if (this._menuStop) break;
        if (events === null) {
          await this.registerPetMenu();
          await sleep(500);
          continue;
        }
        for (const [label, petId] of Object.entries(events)) {
          if (petId) this.onMenuClick(label, petId);
        }
      } catch (e) {
        if (this._menuStop) break;
        log('warn', 'pet menu loop error', { error: String((e && e.message) || e) });
        await sleep(2000);
      }
    }
    this._menuLoopRunning = false;
  }

  stopMenuLoop() {
    this._menuStop = true;
    this.pet.unregisterMenu(this.MENU_OWNER).catch(() => {});
  }

  onMenuClick(label, petId) {
    const a = this.MENU_ACTIONS[label];
    if (!a) return;
    log('info', 'pet menu click', { label, action: a.type, pet: petId });
    // 即时回执是**中性**的：动作可能要先启动歇会儿（十几秒），
    // 此时不能说「已经开始专注了」——那会和后面的结果气泡自相矛盾。
    this.notice('收到～', 2500);
    this.runMenuAction(a).catch(() => {});
  }

  async runMenuAction(a) {
    const args = a.type === 'start_focus' ? { minutes: a.minutes }
      : a.type === 'snooze' ? { minutes: a.minutes, reason: '来自桌宠右键菜单' }
        : {};
    const r = await this.petAction(a.type, args);
    if (r && r.ok) {
      // ★ 即使走过自动拉起分支也要回执「实际落下去的状态」：
      //   启动分支只说「已就绪」，用户点的是 25/35/45 哪一档、最后是暂停还是
      //   恢复，都要以歇会儿回执为准（r.minutes / r.paused），不能照抄菜单标签。
      const minutes = Number(r.minutes) > 0 ? Number(r.minutes) : a.minutes;
      const fb = {
        rest_now: r.applied === false ? '现在弹不出提醒（人不在屏幕前）' : '好嘞，这就让你歇会儿～',
        start_focus: `开始专注 ${minutes} 分钟 🍅`,
        toggle_pause: r.paused === true ? '提醒已暂停' : r.paused === false ? '提醒已恢复' : '提醒已暂停/恢复',
        snooze: `行吧，延后 ${minutes} 分钟`,
      }[a.type] || '搞定～';
      this.notice(fb, 4000);
    } else if (r && r.ok === false && !r.bootHandled) {
      // 启动分支自己发过气泡（not-installed / timeout / spawn 失败）就别叠；
      // 其余失败一律要给个说法，不能让用户只看到「收到～」然后什么都没发生。
      const msg = {
        'restnow-not-running': '歇会儿没在运行，先在托盘启动它～',
        'restnow-launch-timeout': '歇会儿启动有点慢，稍后再点一次～',
        'restnow-not-installed': '没找到歇会儿，请先安装（微软商店搜「歇会儿」或到官网下载）～',
        'launch-failed': '启动歇会儿失败了，麻烦手动打开一下～',
        'bridge-unavailable': '连不上歇会儿，稍后再点一次～',
        'no-response': '歇会儿没回应，稍后再点一次～',
      }[r.error] || '这次没成功，稍后再点一次～';
      this.notice(msg, 6000);
    }
  }

  allowed(key, ms) {
    const t = this.lastActionAt.get(key) || 0;
    if (Date.now() - t < ms) {
      this.stats.skipped += 1;
      return false;
    }
    this.lastActionAt.set(key, Date.now());
    return true;
  }

  async act(kind, meta = {}) {
    const pet = this.pet;
    if (kind === 'break-start') {
      if (!this.cfg.announceBreak) return;
      if (!this.allowed('break-start', this.cfg.throttleMs)) return;
      const long = Number(meta.duration) >= 300;
      await pet.say(long ? TEXT.breakLong : TEXT.breakStart, {
        duration: 120000,
        image: long ? MEME.breakLong : MEME.breakStart,
      });
      await pet.play(long ? ANIM.breakLong : ANIM.breakShort);
      this.stats.actions += 1;
      return;
    }
    if (kind === 'break-end') {
      if (!this.allowed('break-end', 5000)) return;
      const el = Number(meta.elapsed) || 0;
      // 刚弹就关 ≠ 好好休息完 —— 别夸，鱼也不装没事
      const quick = el > 0 && el < 15;
      // 真歇够 5 分钟：给鼓励。夸的是「他在爱护身体」，不是「他听话」。
      const long = el >= 300;
      const mins = long ? Math.max(5, Math.round(el / 60)) : 0;
      await pet.say(quick ? TEXT.quickClose
        : long ? TEXT.restPraise(mins)
          : TEXT.breakEnd, {
        // 收窗那一下要短：用户刚关掉提醒，气泡再挂 8 秒会被当成「没消失」。
        duration: quick ? 4500 : 6000,
        image: quick ? MEME.quickClose : (long ? MEME.restPraise : MEME.breakEnd),
      });
      await pet.play(long ? ANIM.celebrate : ANIM.back);
      this.stats.actions += 1;
      if (long) this.stats.longRests = (this.stats.longRests || 0) + 1;
      return;
    }
    if (kind === 'pomo') {
      if (!this.cfg.announcePomo) return;
      if (!this.allowed('pomo', 30000)) return;
      await pet.say(TEXT.pomoDone, { duration: 8000, image: MEME.pomoDone });
      await pet.play(ANIM.celebrate);
      this.stats.actions += 1;
      return;
    }
    if (kind === 'focus-start') {
      if (!this.allowed('focus-start', this.cfg.throttleMs)) return;
      await pet.say(TEXT.focusStart, { duration: 6000, image: MEME.focusStart });
      await pet.play(ANIM.focus);
      this.stats.actions += 1;
      return;
    }
    if (kind === 'snoozed') {
      if (!this.allowed('snoozed', 20000)) return;
      await pet.say(TEXT.snoozed, { duration: 5000, image: MEME.snoozed });
      this.stats.actions += 1;
      return;
    }
    // 「缩为番茄钟」：用户把主界面缩成小钟去干活了 —— 打个招呼再坐过去陪
    if (kind === 'tomato-on') {
      if (!this.allowed('tomato-on', 8000)) return;
      await pet.say(TEXT.tomatoOn, { duration: 6000, image: MEME.tomatoOn });
      await pet.play(ANIM.focus);
      this.stats.actions += 1;
      return;
    }
    // 「重新开始」：用户重置了倒计时，鼓励一下
    if (kind === 'restarted') {
      if (!this.allowed('restarted', 8000)) return;
      await pet.say(TEXT.restarted, { duration: 6000, image: MEME.restarted });
      await pet.play(ANIM.back);
      this.stats.actions += 1;
    }
  }

  onBreak(active, meta = {}) {
    this.resetBreakGuard();   // 新一轮状态，上一轮的兜底观测一律作废
    if (this.muted) return;
    const geo = meta.geo || null;
    // ★ 全屏弹窗 = 整屏半透明遮罩 + 居中卡片。遮罩不是障碍物，
    //   真正的目标是卡片 —— 优先用 popup_card，鱼才能站在卡片正上方。
    const pickTarget = (g) => (g && (g.popup_card || g.popup)) || null;
    const rect = meta.rect || pickTarget(geo);

    if (active) {
      // ★ 自愈（2026-11-07 反馈：只有第一次立即休息鱼会动，之后都不动）。
      //   根因：旧逻辑用 `active === breakActive` 去重，一旦上一轮
      //   `rest.dismissed` 被漏掉（SSE 丢包 / 桥重连瞬间关窗 / 关闭路径没广播），
      //   breakActive 会一直卡 true，导致后续所有落座都被这条去重吃掉。
      //   这里改成：卡在 active 又来了一次 shown（>2s）⇒ 上一轮 dismiss 疑似丢失，
      //   重新落座到当前弹窗旁即可（sitBeside 内部已做幂等去重：已就座则不动，绝不把鱼送回家再拉回来）。
      //   2 秒内的重复 shown = 同一弹窗的重复广播，跳过，避免鱼乱跳。
      if (this.breakActive) {
        const since = Date.now() - (this.lastBreakStartAt || 0);
        if (since > 2000) {
          log('warn', 'break: 检测到上一轮 dismiss 疑似丢失，重新落座', { sinceMs: since });
        } else {
          log('info', 'break: 2 秒内重复 shown，跳过', { sinceMs: since });
          return;
        }
      }
      this.breakActive = true;
      this.lastBreakStartAt = Date.now();
      this.lastBreakAt = nowIso();
      this.stats.breakStarts += 1;
      // 别把整份 geo 打进日志（太长），只留排障用得上的字段
      log('info', 'break started', {
        source: meta.source, duration: meta.duration, forced: meta.forced,
        fullscreen: meta.fullscreen, rect: rect || null,
        card: (geo && geo.popup_card) || null,
      });
      this.act('break-start', meta).catch(() => {});
      // 陪工位：坐到弹窗旁边，别压着倒计时
      if (rect) {
        this.seat.sitBeside('rest', rect, [geo && geo.tomato]).catch(() => {});
      } else {
        // 弹窗刚建、这一刻还量不出矩形 ——「有时候不联动」就是这么来的。
        // 隔一拍拿最新几何补一次，别让这一次休息白瞎。
        setTimeout(() => {
          const g2 = this.lastGeo;
          const r2 = pickTarget(g2);
          log('info', 'seat: 补一次落座尝试', { got: Boolean(r2) });
          if (r2) this.seat.sitBeside('rest', r2, [g2 && g2.tomato], { force: true }).catch(() => {});
        }, 300);
      }
    } else {
      // dismiss：若没有对应的 shown（重复 / 乱序 / 自愈时已归位），忽略，别重复归位。
      if (!this.breakActive) {
        log('info', 'break: 收到 dismiss 但当前不在休息态，忽略', { source: meta.source });
        return;
      }
      this.breakActive = false;
      this.lastBreakEndAt = Date.now();
      this.stats.breakEnds += 1;
      log('info', 'break ended', { source: meta.source, elapsed: meta.elapsed });
      this.act('break-end', meta).catch(() => {});
      this.seat.restore('break-end').catch(() => {});
    }
  }

  onRestNowGone() {
    if (this.breakActive) {
      this.breakActive = false;
      this.lastBreakEndAt = Date.now();
      log('warn', 'restnow exited during break → 自愈归位');
      this.seat.restore('restnow-gone').catch(() => {});
    }
  }

  /* -------- 休息态「弹窗已关但没收到 rest.dismissed」的兜底（1.4.5） -------- */

  /**
   * 真因（2026-11-07 反馈 #3）：右下角小卡被「取消 / × / Esc」关掉时走的是
   *   ReminderPopup.close() → _destroy() → App._popup_closed()
   * 这条路径**不广播** rest.dismissed；产品里唯一的广播点在 App._dismiss_popup()，
   * 只服务锁屏 / 解锁 / 屏幕关闭静音这些系统级收窗。
   * 而窗口观察器只按「TkTopLevel 面积 ≥ 55% 屏幕」认全屏弹窗，小卡永远不让
   * active 变 true，自然也不会有 active=false 的兜底 ⇒ breakActive 卡 true、
   * seat.at 不清空，鱼一直蹲在右下角（真机日志里 49 秒等不到 break ended）。
   *
   * 两类信号都喂给这里：
   *  ① timer.tick 的 popup_open === false：产品侧 `app._popup is not None` 的反面，
   *     权威布尔，一票即归位（但 tick 每 60s 才一发，只靠它太慢）。
   *  ② /v1/snapshot 的 geo.popup / geo.popup_card 皆 null：几何推断，
   *     必须 geo.screen 在场（产品重启 / 探测异常时几何不可信），
   *     且连续两票、跨过 900ms，防一次量不到就把鱼送回家。
   */
  observeBreakPopup(payload = {}, source = 'unknown', opts = {}) {
    if (!this.breakActive || this.muted) return false;
    if (this.cfg.breakPopupGuard === false) return false;
    // 刚 shown 的这段不采信「没弹窗」：建窗 / 换窗 / SSE 补发都可能瞬间量不到矩形
    if (!opts.force && Date.now() - (this.lastBreakStartAt || 0) < BREAK_GUARD_GRACE_MS) return false;

    const geo = payload.geo || null;
    const explicitClosed = payload.popup_open === false;
    const geoTrusted = Boolean(geo && geo.screen);
    const noPopup = geoTrusted && !geo.popup && !geo.popup_card;

    if (explicitClosed) return this.finishBreakByGuard('popup_open=false', source);
    // 权威布尔与几何冲突时以布尔为准：产品说「弹窗还开着」，几何量不到也不许归位
    if (payload.popup_open === true || !noPopup) {
      if (this.breakGuardStreak) {
        log('info', 'break: 弹窗仍在，撤销归位判定', {
          source, streak: this.breakGuardStreak, popupOpen: payload.popup_open,
        });
      }
      this.resetBreakGuard();
      return false;
    }
    const now = Date.now();
    if (!this.breakGuardStreak) this.breakGuardSince = now;
    this.breakGuardStreak += 1;
    if (this.breakGuardStreak < BREAK_GUARD_MIN_SAMPLES
        || now - this.breakGuardSince < BREAK_GUARD_MIN_SPAN_MS) return false;
    return this.finishBreakByGuard('geo.popup=null', source);
  }

  finishBreakByGuard(reason, source) {
    this.resetBreakGuard();
    const elapsed = Math.max(0, (Date.now() - (this.lastBreakStartAt || Date.now())) / 1000);
    this.stats.breakPopupGuard += 1;
    log('warn', 'break: 弹窗已关闭但未收到 rest.dismissed，兜底归位', {
      source, reason, elapsedSec: Math.round(elapsed), guardTotal: this.stats.breakPopupGuard,
    });
    this.onBreak(false, {
      source: `popup-gone:${source}`, elapsed, dismissMissing: true, reason,
    });
    return true;
  }

  /** 快路径：休息态里每轮 poll 拉一次 /v1/snapshot（只在 breakActive 为真时发请求）。 */
  async probeBreakPopup() {
    if (!this.breakActive || this.muted || this.cfg.breakPopupGuard === false) return false;
    if (this._breakProbeBusy || typeof this.bridge?.snapshotDeep !== 'function') return false;
    this._breakProbeBusy = true;
    try {
      const snap = await this.bridge.snapshotDeep();
      // 拿不到 = 未知，不投赞成票也不投反对票（SSE 的 dismiss 仍是主路径）
      if (!snap) return false;
      return this.observeBreakPopup({ geo: snap, popup_open: snap.popup_open }, 'snapshot');
    } catch {
      return false;
    } finally {
      this._breakProbeBusy = false;
    }
  }

  /* -------- 本机桥（歇会儿 1.0.9+） -------- */

  onBridgeEvent(evt) {
    if (!evt || !evt.kind) return;
    const d = evt.data || {};
    // 事件里带的几何立刻进缓存 —— 陪工位算座位时不用再拉一次
    if (d.geo) this.ingestGeo(d.geo);
    switch (evt.kind) {
      case 'rest.shown':
        this.onBreak(true, {
          source: 'bridge',
          duration: d.duration_sec,
          forced: d.forced,
          fullscreen: d.fullscreen,
          credit: d.credit,
          todayCount: d.today_count,
          geo: d.geo || null,
          rect: (d.geo && (d.geo.popup_card || d.geo.popup)) || null,
        });
        break;
      case 'rest.dismissed':
        this.onBreak(false, {
          source: 'bridge',
          elapsed: d.elapsed_sec,
          escapeUsed: d.escape_used,
          credit: d.credit,
          geo: d.geo || null,
        });
        break;
      case 'pomo.started':
        this.act('focus-start').catch(() => {});
        // 陪工位：番茄钟开跑 → 挪到钟旁边
        this.seat.sitBeside('focus', d.geo && d.geo.tomato).catch(() => {});
        // 让鱼自己「说」一句，从鱼身上得到明确反馈（#3：从鱼启动专注也要有可见回应）
        this.pet.say('开始专注啦，我坐这儿陪你 🍅', { duration: 6000 }).catch(() => {});
        break;
      // ---- 用户手动操作（托盘 / 主界面按钮）----
      case 'tomato.shown':
        // 点了「🍅 缩为番茄钟」：先打个招呼，再坐到小钟旁边
        this.act('tomato-on').catch(() => {});
        this.seat.sitBeside('focus', d.geo && d.geo.tomato, [], { force: true })
          .catch(() => {});
        break;
      case 'tomato.hidden':
        // 点小钟回主界面了 —— 没有目标可陪，归位
        this.seat.restore('tomato-hidden').catch(() => {});
        break;
      case 'timer.restarted':
        this.act('restarted').catch(() => {});
        break;
      case 'pomo.logged':
        // 只有「真的休息了一段」才算一轮完成；快速退出 / 纯专注不庆祝。
        if (Number(d.rest_sec) >= 30 && !d.quick) {
          this.stats.pomoCompleted += 1;
          log('info', 'pomodoro completed (bridge)', d);
          if (Date.now() - this.lastBreakEndAt > 12000) this.act('pomo').catch(() => {});
        }
        break;
      case 'remind.snoozed':
        this.act('snoozed', d).catch(() => {});
        break;
      case 'timer.paused':
        this.restnowPaused = Boolean(d.paused);
        break;
      case 'timer.resumed':
        this.restnowPaused = Boolean(d.paused);
        break;
      case 'timer.tick':
        // 用户把番茄钟拖走了才跟着挪；没拖就不动，别让桌宠满屏乱跑
        if (this.seat.at && this.seat.why === 'focus') {
          this.seat.reseatIfMoved(d.geo && d.geo.tomato).catch(() => {});
        }
        // 小卡被手动取消时产品不发 rest.dismissed；tick 里的 popup_open 是权威闭窗信号
        this.observeBreakPopup({ geo: d.geo, popup_open: d.popup_open }, 'tick');
        break;
      case 'app.bye':
        log('info', 'restnow said goodbye');
        this.bridgeMode = false;
        this.onRestNowGone();
        break;
      default:
        break;
    }
  }

  onBridgeDown() {
    this.bridgeMode = false;
    log('warn', 'bridge down → 退回窗口观察器（桥仍在后台重连）');
    // 桥断了，watcher 得从「只管置顶」升级成「完整推算 + 挪鱼」。
    if (this.cfg.watchWindows) this.watcher.restart(false).catch(() => {});
    // 立刻把重探节拍叫醒，别等下一轮 8 秒
    this.armBridgeWatch(1000);
  }

  /**
   * 桥后来才活 —— 常见顺序是「先开 DSH 再开歇会儿」，或者歇会儿重装/重启。
   * 只靠启动时那一次 `probe()` 的话，整个会话都停在窗口观察器模式：
   * 没有事件流、没有反向控制、没有 `raiseOnly` 的降压置顶守卫
   * （2026-11-07 实测：先开 DSH 后开歇会儿，日志只有 `bridge not available`，
   *   鱼照旧会被全屏遮罩压暗，而且一路不会自愈）。
   */
  async onBridgeUp() {
    if (this.bridgeMode) return;
    this.bridgeMode = true;
    this.bridge.start();
    log('info', 'bridge up（切到事件流）', {
      port: this.bridge.port, restnow: this.bridge.appVersion,
    });
    // watcher 要从「完整推算 + 挪鱼」降级成「只管置顶」（见 onBridgeDown 反着来）
    if (this.cfg.watchWindows) this.watcher.restart(true).catch(() => {});
  }

  /**
   * 桥的「重探节拍」。
   * ★ 独立于 `poll()` 的理由：`poll()` 里早早就 `if (!snap) return`（读不到
   *   配置文件就直接返回），把重探塞在那里会出现「没配置 ⇒ 不探测 ⇒ 永远不连」
   *   的互相拖死。这里用独立定时器 + 退避：1s → 2s → 3s → 5s → 8s。
   */
  armBridgeWatch(delay) {
    if (this.bridgeWatchStopped) return;
    if (this.bridgeWatchTimer) clearTimeout(this.bridgeWatchTimer);
    this.bridgeWatchTimer = setTimeout(() => {
      this.bridgeWatchTimer = null;
      this.bridgeTick().catch(() => {});
    }, Math.max(0, Number(delay) || 0));
    if (this.bridgeWatchTimer.unref) this.bridgeWatchTimer.unref();
  }

  async bridgeTick() {
    if (this.bridgeWatchStopped) return;
    if (!this.cfg.useBridge) {
      this.armBridgeWatch(10000);
      return;
    }
    // 已经在桥模式：SSE 的存活由 BridgeClient 自己的心跳看住，这里只低频对账
    if (this.bridgeMode) {
      this.bridgeTries = 0;
      this.armBridgeWatch(8000);
      return;
    }
    this.bridgeTries += 1;
    let ok = false;
    try {
      ok = await this.bridge.probe();
    } catch (e) {
      log('warn', 'bridge probe threw', { error: String((e && e.message) || e) });
    }
    if (ok) {
      this.bridgeTries = 0;
      await this.onBridgeUp();
      this.armBridgeWatch(8000);
      return;
    }
    const delays = [1000, 2000, 3000, 5000, 8000];
    this.armBridgeWatch(delays[Math.min(this.bridgeTries - 1, delays.length - 1)]);
  }

  /** 气泡提示（桌宠可见）；测试里可整体替换成收集器。 */
  notice(text, duration = 6000) {
    if (!text || this.muted) return;
    this.pet.say(text, { duration }).catch(() => {});
  }

  /** 等歇会儿把 bridge.json / HTTP 服务拉起来；新进程端口和 token 每次都变，必须重新 probe。 */
  async waitBridgeReady(timeoutMs = 20000) {
    const delays = [400, 600, 800, 1000, 1500, 2000, 2000, 2000];
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (!this.probe.configPath) this.probe.configPath = findRestNowConfig();
      if (await this.bridge.probe()) return true;
      await new Promise((r) => setTimeout(r, delays[Math.min(i++, delays.length - 1)]));
    }
    return false;
  }

  /** 拉起歇会儿并等桥就绪；同一时刻并发点多次只拉一次。 */
  async launchRestNow(action = null) {
    if (this._launching) return this._launching;
    this._launching = (async () => {
      const deps = this.launchDeps || {};
      const findPid = deps.findPid || findRestNowPid;
      const resolveLauncher = deps.resolveLauncher || resolveRestNowLauncher;
      const doSpawn = deps.spawn || spawn;
      const wantTomatoOnly = this.cfg.launchTomatoOnly !== false;
      let didSpawn = false;
      let launcher = null;
      let launchedCmd = null;
      let launchError = '';

      const spawnOnce = async () => {
        if (!launcher) launcher = await resolveLauncher(this.cfg, this.probe.configPath);
        if (!launcher) {
          launchError = 'restnow-not-installed';
          this.notice('还没找到歇会儿，请先安装（微软商店搜「歇会儿」或到官网下载）～', 9000);
          log('warn', 'launch: restnow not installed');
          return false;
        }
        const cmd = buildLaunchCommand(launcher, { tomatoOnly: wantTomatoOnly });
        this.notice(cmd && cmd.degraded
          ? '歇会儿没开，我帮你启动一下…（商店版暂不能静默进番茄钟，主界面会亮一下）'
          : '歇会儿没开，我帮你启动一下…（直接进番茄钟）');
        try {
          const child = doSpawn(cmd.command, cmd.args, cmd.opts);
          child.unref();
          didSpawn = true;
          launchedCmd = cmd;
          log('info', 'launch: spawned restnow', {
            kind: launcher.kind, target: launcher.target, args: cmd.args,
            tomatoOnly: cmd.tomatoOnly, degraded: cmd.degraded, action: action && action.type,
          });
          return true;
        } catch (e) {
          launchError = 'launch-failed';
          log('warn', 'launch: spawn failed', { error: String(e && e.message ? e.message : e) });
          this.notice('启动歇会儿失败了，麻烦手动打开一下～', 7000);
          return false;
        }
      };

      // ★★ 绝不能把 this.bridge.pid 当 hint：那是上一次成功 probe 留下的，
      //    歇会儿退出后仍在；而 findRestNowPid(hint) 对非 0 hint **直接返回、不验活**
      //    ⇒ 误判「进程已在跑」⇒ 一个都不拉、白等 20 秒（真机 08:34 三次点击实证）。
      //    传 0 强制按进程名 / 命令行实查；真在跑的进程照样能查到，不会双开。
      const pid = await findPid(0);
      if (!pid) {
        if (!(await spawnOnce())) {
          return { ok: false, error: launchError, message: launchError === 'launch-failed' ? '启动歇会儿失败' : '未检测到歇会儿安装' };
        }
      } else {
        log('info', 'launch: process alive, waiting for bridge', { pid });
      }

      let ready = await this.waitBridgeReady(12000);
      if (!ready && !didSpawn) {
        // 实查到的 pid 可能是僵尸 / 同名残留：桥始终没起来 ⇒ 补一次启动，别让用户干等
        log('warn', 'launch: pid present but bridge never came up, retry spawn', { pid });
        if (await spawnOnce()) ready = await this.waitBridgeReady(12000);
      }
      if (!ready) {
        this.notice('歇会儿启动有点慢，稍后再点一次～');
        log('warn', 'launch: bridge not ready', { didSpawn, pid });
        return { ok: false, error: 'restnow-launch-timeout', message: '等待歇会儿就绪超时' };
      }
      // ★ 自动拉起后必须**真正**接上 SSE：onBridgeUp() 开头是 `if (bridgeMode) return`，
      //    直接写 `bridgeMode = true` 会让 bridgeTick 误以为已连上，事件流永远不启动。
      if (!this.bridgeMode) await this.onBridgeUp();
      else if (typeof this.bridge.start === 'function') this.bridge.start();
      if (didSpawn) {
        this.stats.launches = (this.stats.launches || 0) + 1;
        this.lastLaunch = {
          at: nowIso(), kind: launcher && launcher.kind,
          args: launchedCmd ? launchedCmd.args : [],
          tomatoOnly: Boolean(launchedCmd && launchedCmd.tomatoOnly),
          degraded: Boolean(launchedCmd && launchedCmd.degraded),
          reason: launchedCmd ? launchedCmd.reason : 'unknown',
          action: action && action.type ? action.type : null,
        };
      }
      // 只报「就绪」：动作还在 petAction 里等稳定期后下发，别提前宣称已执行。
      this.notice('歇会儿已就绪 ✅');
      // launched=真的 spawn 过；bootHandled=走了启动分支（是否已发过提示，供 UI 避免叠气泡）
      return {
        ok: true, launched: didSpawn, bootHandled: true,
        tomatoOnly: Boolean(launchedCmd && launchedCmd.tomatoOnly),
        degraded: Boolean(launchedCmd && launchedCmd.degraded),
        reason: launchedCmd ? launchedCmd.reason : (didSpawn ? '' : 'already-running'),
      };
    })();
    try {
      return await this._launching;
    } finally {
      this._launching = null;
    }
  }

  /** 桌宠/斜杠命令 → 歇会儿（反向控制）。没在跑时自动拉起，没装则提示安装。 */
  async petAction(type, args = {}) {
    let launched = false;
    let bootHandled = false;
    // ★★ 不能用 snapshot().available 判「歇会儿在不在跑」：它只代表「读到过描述文件」。
    //    程序退出后 port/token 仍残留 ⇒ available=true ⇒ 整段启动分支被跳过，
    //    动作打到死端口，且菜单层对这类错误是静默的（用户只看到「收到～」）。
    //    判据：先 ping（无副作用的真 HTTP 探活），失败再 probe（可能换了端口/token），
    //    两者都失败才认定「没启动」。
    const alive = (typeof this.bridge.ping === 'function' && await this.bridge.ping())
      || await this.bridge.probe();
    let boot = null;
    if (!alive) {
      if (!this.cfg.autoLaunchRestNow) {
        return { ok: false, error: 'restnow-not-running', message: '歇会儿没在运行，先在托盘启动它' };
      }
      // 把「用户刚点的那条命令」带进启动链路：启动方式（--startup）和
      // 稍后要重发的动作都由它决定，日志里也能一眼对上。
      boot = await this.launchRestNow({ type, args });
      // 启动分支自己已经发过气泡，带 bootHandled 让 UI 别再叠一条
      if (!boot.ok) return { ...boot, launched: false, bootHandled: true };
      launched = Boolean(boot.launched);
      bootHandled = Boolean(boot.bootHandled);
    } else if (!this.bridgeMode) {
      // ping 通但还没进过桥模式：必须走 onBridgeUp 把 SSE 接上，
      // 直接置 bridgeMode=true 会让 bridgeTick 以为已连上、永远不重连。
      await this.onBridgeUp();
    }
    // ★ 刚拉起的进程：桥（_late_init，after 120ms）已起，但番茄钟的
    //   `_boot_to_tomato` 排在 after(60ms)、首帧渲染可能还没跑完。
    //   等一小段再下发用户点过的那条命令，番茄钟显示的状态才是它点的那档。
    const settle = Math.min(2000, Math.max(0, Number(this.cfg.launchSettleMs) || 0));
    if (launched && settle) await new Promise((r) => setTimeout(r, settle));
    let r = await this.bridge.action(type, args);
    // 启动后第一次动作失败：只对幂等动作补发一次（toggle_pause / quit 重发会翻两次）
    if (launched && (!r || r.ok !== true) && RETRY_SAFE_ACTIONS.has(type)) {
      await new Promise((r2) => setTimeout(r2, 500));
      r = await this.bridge.action(type, args);
    }
    if (r && r.ok) this.stats.bridgeActions += 1;
    // 真机取证：把启动后的番茄钟可见状态写进 harness.log，别靠猜。
    if (launched && typeof this.geo === 'function') {
      this.geo(true).then((g) => log('info', 'launch: post-start state', {
        action: type,
        tomatoVisible: Boolean(g && g.tomato_probe && g.tomato_probe.visible),
        tomatoRect: g && g.tomato ? g.tomato : null,
        tomatoOnly: Boolean(boot && boot.tomatoOnly),
      })).catch(() => {});
    }
    return r
      ? {
          ...r, launched, bootHandled,
          tomatoOnly: Boolean(boot && boot.tomatoOnly),
          degraded: Boolean(boot && boot.degraded),
        }
      : { ok: false, error: 'no-response', launched, bootHandled };
  }

  async poll() {
    // 放在 probe.snapshot() 之前：config.json 读不到时也不能把归位兜底一起饿死
    this.probeBreakPopup().catch(() => {});
    try {
      const snap = this.probe.snapshot();
      if (!snap) return;
      const prev = this.lastSnapshot;
      this.lastSnapshot = snap;
      if (!prev) return;
      const grew = snap.pomoCount > prev.pomoCount;
      const tsChanged = snap.lastPomoTs && snap.lastPomoTs !== prev.lastPomoTs;
      if (grew || tsChanged) {
        this.stats.pomoCompleted += 1;
        log('info', 'pomodoro completed', { lastPomo: snap.lastPomo, count: snap.pomoCount });
        if (Date.now() - this.lastBreakEndAt > 12000) this.act('pomo').catch(() => {});
      }
      if (snap.intervalMin !== prev.intervalMin || snap.tomatoTheme !== prev.tomatoTheme) {
        log('info', 'restnow settings changed', { intervalMin: snap.intervalMin, tomatoTheme: snap.tomatoTheme });
      }
      // 用户随时可能手动拖鱼 —— 空闲时把「家」跟到它实际待的地方
      this.seat.syncHome().catch(() => {});
    } catch (e) {
      log('warn', 'poll failed', { error: String(e && e.message ? e.message : e) });
    }
  }

  simulate(topic) {
    if (topic === 'break-start') {
      this.onBreak(true, { source: 'simulate' });
      return true;
    }
    if (topic === 'break-end') {
      this.onBreak(false, { source: 'simulate' });
      return true;
    }
    if (topic === 'break-gone') {
      // 复现「取消小卡但产品没发 rest.dismissed」：强制走兜底路径，不直接 onBreak(false)
      return this.observeBreakPopup({ popup_open: false }, 'simulate', { force: true });
    }
    if (topic === 'pomo') {
      this.stats.pomoCompleted += 1;
      this.act('pomo').catch(() => {});
      return true;
    }
    if (topic === 'focus-start') {
      this.act('focus-start').catch(() => {});
      return true;
    }
    if (topic === 'seat') {
      this.seat.sitBeside('focus', this.lastGeo && this.lastGeo.tomato, [], { force: true }).catch(() => {});
      return true;
    }
    if (topic === 'home') {
      this.seat.restore('simulate').catch(() => {});
      return true;
    }
    return false;
  }

  setMuted(on) {
    this.muted = Boolean(on);
    log('info', 'mute changed', { muted: this.muted });
    return this.muted;
  }

  async status(deep = false) {
    const snap = this.lastSnapshot || this.probe.snapshot();
    let petState = null;
    if (deep) petState = await this.pet.state();
    return {
      ok: true,
      plugin: name,
      version: VERSION,
      startedAt: this.startedAt,
      now: nowIso(),
      muted: this.muted,
      breakActive: this.breakActive,
      breakGuard: {
        enabled: this.cfg.breakPopupGuard !== false,
        streak: this.breakGuardStreak,
        recovered: this.stats.breakPopupGuard,
      },
      // 运行时证据：自动拉起是否带 --startup、上一次拉起用了哪种入口
      launchMode: {
        tomatoOnly: this.cfg.launchTomatoOnly !== false,
        settleMs: Number(this.cfg.launchSettleMs) || 0,
        last: this.lastLaunch || null,
      },
      stats: this.stats,
      pet: this.pet.snapshot(),
      raisePetOnBreak: Boolean(this.cfg.raisePetOnBreak),
      petTitle: this.cfg.petTitle,
      petStateSections: petState && petState.sections ? Object.keys(petState.sections) : null,
      restnow: snap
        ? {
            configPath: snap.configPath,
            intervalMin: snap.intervalMin,
            popupSec: snap.popupSec,
            forceRest: snap.forceRest,
            statCount: snap.statCount,
            pomoCount: snap.pomoCount,
            lastPomo: snap.lastPomo,
            theme: snap.theme,
            tomatoTheme: snap.tomatoTheme,
          }
        : { configPath: this.probe.configPath, found: false },
      watcher: this.watcher.snapshot(),
      bridge: this.bridge.snapshot(),
      // 「连不上」时看这一段就够了：地址从哪来、试了几次、上回错在哪
      link: {
        mode: this.bridgeMode ? 'bridge' : 'watcher',
        descriptor: this.bridge.descriptor || null,
        configDir: this.bridge.configDir() || null,
        port: this.bridge.port || null,
        connected: this.bridge.connected,
        degraded: this.bridge.degraded,
        silentMs: this.bridge.lastSeenAt ? Date.now() - this.bridge.lastSeenAt : null,
        retries: this.bridge.retries,
        probeTries: this.bridge.probeTries,
        probeError: this.bridge.probeError || null,
        pet: {
          port: this.pet.port || null,
          petId: this.pet.petId || null,
          failures: this.pet.failures,
          lastError: this.pet.lastError,
        },
      },
      bridgeMode: this.bridgeMode,
      restnowPaused: this.restnowPaused,
      seat: this.seat.snapshot(),
      geo: this.lastGeo
        ? { screen: this.lastGeo.screen, tomato: this.lastGeo.tomato, popup: this.lastGeo.popup }
        : null,
      lastBreakAt: this.lastBreakAt,
      degraded: !this.pet.port,
    };
  }

  statusText() {
    const p = this.pet.snapshot();
    const r = this.lastSnapshot;
    const petTxt = p.port
      ? `桌宠 ${p.petId}@${p.port}（动作 ${p.plays} 次` + (p.lastError ? `，最近错误 ${p.lastError}` : '') + '）'
      : '桌宠未连通';
    const rnTxt = r
      ? `歇会儿：间隔 ${r.intervalMin} 分钟、弹窗 ${r.popupSec}s、今日完成 ${r.statCount} 轮（日志 ${r.pomoCount} 条）`
      : '歇会儿：未找到配置文件';
    const w = this.watcher.snapshot();
    const b = this.bridge.snapshot();
    let wTxt;
    if (this.bridgeMode) {
      wTxt = `本机桥${b.connected ? '已连接' : '连接中'}（端口 ${b.port}`
        + (b.appVersion ? `，歇会儿 ${b.appVersion}` : '') + '）';
    } else {
      wTxt = this.cfg.watchWindows ? (w.running ? '弹窗观察器运行中' : '弹窗观察器未运行') : '弹窗观察器已关闭';
    }
    const bTxt = this.breakActive ? '当前：休息中' : (this.restnowPaused ? '当前：已暂停' : '当前：专注/空闲');
    const s = this.seat.snapshot();
    const sTxt = s.at
      ? `陪工位：${s.why === 'rest' ? '在弹窗旁' : '在番茄钟旁'}（${s.at.x.toFixed(3)}, ${s.at.y.toFixed(3)}）`
      : '陪工位：在休息';
    const mTxt = this.muted ? '（已静音）' : '';
    return `${petTxt}；${rnTxt}；${wTxt}；${bTxt}；${sTxt}${mTxt}`;
  }

  /** `/restnow doctor`：链路排障一屏。连不上时先看这个，别猜。 */
  doctorText() {
    const b = this.bridge.snapshot();
    const p = this.pet.snapshot();
    const w = this.watcher.snapshot();
    const ago = (ms) => {
      if (ms === null || ms === undefined) return '—';
      if (ms < 1000) return '刚刚';
      if (ms < 60000) return `${Math.round(ms / 1000)} 秒前`;
      return `${Math.round(ms / 60000)} 分钟前`;
    };
    const lines = [
      `链路诊断（插件 ${VERSION}）`,
      `  模式：${this.bridgeMode ? '本机桥（事件流）' : '窗口观察器（降级）'}`,
      `  描述文件：${b.descriptor || '未找到'}`,
      `  数据目录：${b.configDir || '未找到（拿不到 config.json）'}`,
      `  桥：端口 ${b.port || '—'}，${b.connected ? '已连接' : (b.available ? '可用未连' : '不可用')}`
        + `，静默 ${ago(b.silentMs)}，seq ${b.lastSeq}，重连 ${b.reconnects} 次`,
      `  探测：共 ${b.probeTries} 次，上次 ${ago(b.probeAgoMs)}`
        + (b.probeError ? `，上次错误 ${b.probeError}` : ''),
      `  桌宠：${p.port ? `${p.petId}@${p.port}` : '未连通'}，失败 ${p.failures} 次`
        + (p.lastError ? `，最近错误 ${p.lastError}` : ''),
      `  观察器：${w.running ? `运行中（目标 pid ${w.targetPid || '?'}）` : '未运行'}`,
    ];
    if (!b.available) {
      lines.push('  → 桥不可用时的自愈顺序：每 1/2/3/5/8 秒重探一次，'
        + '歇会儿起来后会自动切回事件流，不用重启 DSH。');
    } else if (!b.connected) {
      lines.push('  → 桥可用但没连上：执行 `/restnow reconnect`，或 POST /reconnect。');
    }
    return lines.join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * 本机控制面（验收 / 后续 UI 用）
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** 列出本机局域网 IPv4，供日志给出「手机该访问哪个地址」。 */
function lanIps() {
  const out = [];
  try {
    for (const list of Object.values(networkInterfaces() || {})) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) out.push(n.address);
      }
    }
  } catch { /* 拿不到不影响服务 */ }
  return out;
}

function startSurface(engine, cfg) {
  let port = Number(cfg.bridgePort) || 47110;
  let attempts = 0;
  const lan = Boolean(cfg.webLan);
  const host = lan ? String(cfg.webHost || '0.0.0.0') : '127.0.0.1';
  // ★ 局域网必须带口令：这个服务能触发全屏弹窗 / 改配置 / 关主程序，
  //   裸奔在局域网等于把电脑交给同网段任何人。自己生成时把带 token 的完整 URL 打进日志。
  const token = String(cfg.webToken || (lan ? randomBytes(12).toString('hex') : ''));
  const checkToken = (req, url) => {
    if (!token) return true;
    const got = String(req.headers['x-restnow-token'] || url.searchParams.get('token') || '');
    if (got.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (code, obj) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      // 面板静态页不设口令（否则第一次打不开、没法输口令）；所有数据/动作接口都设。
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const buf = Buffer.from(PANEL_HTML, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length });
        return res.end(buf);
      }
      if (!checkToken(req, url)) {
        return send(401, { ok: false, error: 'unauthorized', message: '访问口令不对，见 harness.log 里带 token 的网址' });
      }
      if (url.pathname === '/api/features') {
        return send(200, { ok: true, groups: WEB_FEATURE_GROUPS, features: publicFeatures() });
      }
      // Web 面板统一入口：只认白名单 id，前端不能注入任意 type
      if (url.pathname === '/api/run' && req.method === 'POST') {
        const body = await readBody(req);
        const spec = buildRunArgs(String((body && body.id) || ''), (body && body.values) || {});
        if (!spec) return send(400, { ok: false, error: 'feature-unavailable', message: '功能未开放或不存在' });
        return send(200, await runWebFeature(engine, spec));
      }
      if (url.pathname === '/health' || url.pathname === '/status') {
        return send(200, await engine.status(url.pathname === '/status'));
      }
      if (url.pathname === '/simulate' && req.method === 'POST') {
        const body = await readBody(req);
        const topic = String((body && body.topic) || url.searchParams.get('topic') || '');
        const ok = engine.simulate(topic);
        return send(ok ? 200 : 400, { ok, topic });
      }
      if (url.pathname === '/mute' && req.method === 'POST') {
        const body = await readBody(req);
        const on = body && typeof body.on === 'boolean' ? body.on : url.searchParams.get('on') === '1';
        return send(200, { ok: true, muted: engine.setMuted(on) });
      }
      if (url.pathname === '/reconnect' && req.method === 'POST') {
        const ok = await engine.bridge.probe();
        if (ok) {
          engine.bridge.reconnectNow('manual');
          await engine.onBridgeUp();
        }
        return send(ok ? 200 : 503, { ok, bridge: engine.bridge.snapshot() });
      }
      // 反向控制（脚本 / 桌宠右键菜单用）：直接转给歇会儿
      if (url.pathname === '/action' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.type) return send(400, { ok: false, error: 'bad-request' });
        const r = await engine.petAction(String(body.type), body.args || {});
        return send(r && r.ok ? 200 : 502, r || { ok: false, error: 'no-response' });
      }
      if (url.pathname === '/bridge') {
        return send(200, { ok: true, ...engine.bridge.snapshot() });
      }
      send(404, { error: 'not-found', path: url.pathname });
    } catch (e) {
      send(500, { error: String(e && e.message ? e.message : e) });
    }
  });

  server.on('error', (e) => {
    attempts += 1;
    if (attempts <= 5) {
      port += 1;
      setTimeout(() => server.listen(port, host), 80);
    } else {
      log('warn', 'surface bind failed', { port, host, error: String(e && e.message ? e.message : e) });
    }
  });

  server.listen(port, host, () => {
    const suffix = token ? `?token=${token}` : '';
    log('info', 'surface listening', { url: `http://127.0.0.1:${port}/${suffix}`, lan, host });
    if (lan) {
      for (const ip of lanIps()) log('info', 'web console URL', { url: `http://${ip}:${port}/${suffix}` });
    }
  });

  return server;
}

/** 执行一个已经过白名单翻译的功能；action 走桥，surface 走插件自身能力。 */
async function runWebFeature(engine, spec) {
  if (spec.kind === 'action') {
    const r = await engine.petAction(spec.type, spec.args || {});
    return r || { ok: false, error: 'no-response' };
  }
  const s = spec.surface;
  if (s === 'mute') return { ok: true, muted: engine.setMuted(spec.on) };
  if (s === 'seat') return { ok: engine.simulate('seat') };
  if (s === 'home') return { ok: engine.simulate('home') };
  if (s === 'launch') return await engine.launchRestNow();
  if (s === 'reconnect') {
    const ok = await engine.bridge.probe();
    if (ok) {
      engine.bridge.reconnectNow('web');
      await engine.onBridgeUp();
    }
    return { ok, bridge: engine.bridge.snapshot() };
  }
  if (s === 'sim-break') {
    engine.simulate('break-start');
    setTimeout(() => engine.simulate('break-end'), 4000);
    return { ok: true };
  }
  if (s === 'sim-pomo') return { ok: engine.simulate('pomo') };
  return { ok: false, error: 'unknown-surface-feature', surface: s };
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

function detectWebPort(ctx) {
  try {
    const ws = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null;
    if (!ws) return 0;
    if (Number(ws.port) > 0) return Number(ws.port);
    if (ws.server && typeof ws.server.address === 'function') {
      const addr = ws.server.address();
      if (addr && Number(addr.port) > 0) return Number(addr.port);
    }
  } catch {}
  return 0;
}

/** 给 smoke / 回归脚本用的内部件（产品代码不用） */
export const _internal = {
  DEFAULTS, findRestNowPid, findPwsh, WindowWatcher, Engine, PetPort, VERSION,
  resolveRestNowLauncher, probeRestNowLaunchers, LAUNCH_OPTS,
  buildLaunchProbeScript, buildLaunchCommand, STARTUP_ARG,
  startSurface, runWebFeature, lanIps,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) {
    log('info', 'disabled by config');
    return;
  }

  const engine = new Engine(cfg);
  const hintPort = detectWebPort(ctx);
  if (hintPort && !cfg.petPort) cfg.petPort = hintPort;
  // ★ 桌宠侧也要能吃「端口变了」：每次重发现都重新问一遍当前 webServer 端口，
  //   而不是只用启动时那一次快照（DSH 自己重启后端口会变）。
  if (typeof cfg.petHintPort !== 'function') cfg.petHintPort = () => detectWebPort(ctx);

  ctx.effect(() => {
    let surface = null;
    engine.start().catch((e) => log('error', 'engine start failed', { error: String(e && e.message ? e.message : e) }));
    try {
      surface = startSurface(engine, cfg);
    } catch (e) {
      log('warn', 'surface start failed', { error: String(e && e.message ? e.message : e) });
    }
    return () => {
      try {
        engine.stop();
      } catch {}
      if (surface) {
        try {
          surface.close();
        } catch {}
      }
    };
  }, 'restnow-bridge: lifecycle');

  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.effect(() => ctx.commands.register({
      name: 'restnow',
      description: '歇会儿联动：查看状态 / 模拟一次休息 / 静音',
      handler: async (rawInput) => {
        const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
        const arg = (parts[0] || '').toLowerCase();
        const num = (def) => {
          const n = Number(parts[1]);
          return Number.isFinite(n) && n > 0 ? n : def;
        };
        if (!arg || arg === 'status' || arg === '状态') {
          return { kind: 'success', text: engine.statusText() };
        }
        if (arg === 'test' || arg === '测试') {
          engine.simulate('break-start');
          setTimeout(() => engine.simulate('break-end'), 4000);
          return { kind: 'success', text: '已模拟：休息开始 → 4 秒后结束，桌宠应各播放一次动作' };
        }
        if (arg === 'break-gone' || arg === '兜底归位') {
          const ok = engine.simulate('break-gone');
          return ok
            ? { kind: 'success', text: '已模拟「取消小卡但没收到 rest.dismissed」，桌宠应已回原位' }
            : { kind: 'error', text: '当前不在休息态（或兜底已关闭），没有可归位的状态' };
        }
        if (arg === 'pomo' || arg === '完成') {
          engine.simulate('pomo');
          return { kind: 'success', text: '已模拟一轮番茄完成' };
        }
        if (arg === 'mute' || arg === '静音') {
          engine.setMuted(true);
          return { kind: 'success', text: '已静音：不再驱动桌宠' };
        }
        if (arg === 'unmute' || arg === '取消静音') {
          engine.setMuted(false);
          return { kind: 'success', text: '已取消静音' };
        }
        if (arg === 'sync' || arg === '对账') {
          engine.pet.port = 0;
          engine.pet.ensure().catch(() => {});
          return { kind: 'success', text: '已触发重新发现桌宠连接' };
        }
        if (arg === 'seat' || arg === '陪工位') {
          const geo = await engine.geo(true);
          if (!geo || !geo.tomato) {
            return { kind: 'error', text: '拿不到番茄钟位置（需要歇会儿 1.0.9+ 且番茄钟已显示）' };
          }
          const r = await engine.seat.sitBeside('focus', geo.tomato, [], { force: true });
          if (!r) return { kind: 'error', text: '番茄钟四周没有不遮挡的空位' };
          return { kind: 'success', text: `已挪到番茄钟旁边（${r.x.toFixed(3)}, ${r.y.toFixed(3)}）` };
        }
        if (arg === 'home' || arg === '归位') {
          const ok = await engine.seat.restore('command');
          return ok ? { kind: 'success', text: '桌宠已回原位' } : { kind: 'error', text: '桌宠本来就在原位' };
        }

        // ---- 反向控制：桌宠 → 歇会儿（需要歇会儿 1.0.9+ 的本机桥）----
        const fail = (r) => ({
          kind: 'error',
          text: (r && (r.message || r.error)) || '操作失败',
        });
        if (arg === 'snooze' || arg === '延后') {
          const minutes = num(30);
          const r = await engine.petAction('snooze', { minutes, reason: '来自桌宠' });
          if (!r || !r.ok) return fail(r);
          return { kind: 'success', text: `已推迟 ${minutes} 分钟，下次提醒 ${r.next_at || '稍后'}` };
        }
        if (arg === 'focus' || arg === '专注') {
          const minutes = num(25);
          const r = await engine.petAction('start_focus', { minutes });
          if (!r || !r.ok) return fail(r);
          return { kind: 'success', text: `已开始专注 ${minutes} 分钟` };
        }
        if (arg === 'pause' || arg === '暂停') {
          if (!engine.restnowPaused) {
            const r = await engine.petAction('toggle_pause', {});
            if (!r || !r.ok) return fail(r);
          }
          return { kind: 'success', text: '歇会儿已暂停计时' };
        }
        if (arg === 'resume' || arg === '继续') {
          if (engine.restnowPaused) {
            const r = await engine.petAction('toggle_pause', {});
            if (!r || !r.ok) return fail(r);
          }
          return { kind: 'success', text: '歇会儿已继续计时' };
        }
        if (arg === 'rest' || arg === '休息') {
          const r = await engine.petAction('rest_now', {});
          if (!r || !r.ok) return fail(r);
          return {
            kind: r.applied ? 'success' : 'error',
            text: r.applied ? '已弹出休息提醒' : '弹不出来：人不在屏幕前（锁屏/息屏）',
          };
        }
        if (arg === 'bridge' || arg === '桥接') {
          const b = engine.bridge.snapshot();
          return {
            kind: 'success',
            text: `桥接${b.available ? (b.connected ? '已连接' : '可用未连') : '不可用'}`
              + (b.port ? `，端口 ${b.port}，事件 ${b.events}，动作 ${b.actions}` : '')
              + (b.appVersion ? `，歇会儿 ${b.appVersion}` : ''),
          };
        }
        // 连不上时用它：地址从哪来、试了几次、上回错在哪，一眼看清
        if (arg === 'doctor' || arg === '诊断') {
          return { kind: 'success', text: engine.doctorText() };
        }
        if (arg === 'reconnect' || arg === '重连') {
          const ok = await engine.bridge.probe();
          if (!ok) {
            return { kind: 'error', text: `重连失败：${engine.bridge.probeError || '找不到 bridge.json'}` };
          }
          engine.bridge.reconnectNow('command');
          await engine.onBridgeUp();
          return { kind: 'success', text: `已重连：端口 ${engine.bridge.port}（歇会儿 ${engine.bridge.appVersion || '?'}）` };
        }
        return {
          kind: 'error',
          text: '用法：/restnow [status|doctor|reconnect|test|break-gone|pomo|mute|unmute|sync|seat|home|snooze 30|focus 25|pause|resume|rest|bridge]',
        };
      },
    }), 'restnow-bridge: /restnow command');
  }

  try {
    ctx.provide('restnowBridge', {
      status: () => engine.status(true),
      simulate: (topic) => engine.simulate(topic),
      mute: (on) => engine.setMuted(on),
      action: (type, args) => engine.petAction(type, args),
      bridge: () => engine.bridge.snapshot(),
      seat: () => engine.seat.snapshot(),
      geo: () => engine.geo(true),
    });
  } catch (e) {
    log('warn', 'service provide failed', { error: String(e && e.message ? e.message : e) });
  }

  log('info', 'plugin applied', { version: VERSION, bridgePort: cfg.bridgePort, hintPort });
}
