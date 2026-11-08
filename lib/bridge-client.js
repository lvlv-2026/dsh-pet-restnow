/**
 * bridge-client —— 与「歇会儿」本机桥（restnow_bridge）通信
 *
 * 协议见歇会儿仓库的 restnow_bridge.py：
 *   GET  /v1/health          探活（免鉴权）
 *   GET  /v1/snapshot        全量状态
 *   GET  /v1/events          SSE 事件流
 *   POST /v1/action          动作下发（带 id 幂等）
 *
 * ★ 这个模块只做搬运，不认识任何业务语义；事件/动作的解释权在 Engine。
 *   桥接不可用（旧版歇会儿）时 `probe()` 返回 false，调用方退回窗口观察器。
 *
 * ★★★ 稳定性设计（2026-11-07 加固）
 *   ① **地址是推导出来的，不是猜的**：歇会儿的 `config.json` 和 `bridge.json`
 *      永远写在同一个数据目录里（`_pick_data_dir()` 决定的），
 *      所以拿到 config 路径就等于拿到 bridge 路径 —— 源码直跑、打包版、
 *      MSIX 三种发行版一条逻辑全覆盖。
 *   ② **永不放弃重连**：本地回环，8 秒一次的代价可以忽略；
 *      连续失败到阈值只通知上层「先降级」，重连本身照旧。
 *   ③ **心跳**：SSE 可能半死（socket 还在、服务端不再发数据），
 *      靠「静默超时 → /v1/health 探活 → 连不通就主动断开重连」兜住。
 *   ④ **动作失败自动重探**：歇会儿重启过 ⇒ 端口和 token 都变了，
 *      401/连不上时重新找一遍描述文件再试一次，用户不会看到「第一次点没反应」。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet, request as httpRequest } from 'node:http';

const DEFAULT_TIMEOUT = 2500;

/** SSE 断线重连的退避序列（毫秒）。跑到底就停在最后一档，**永不放弃**。 */
const RECONNECT_DELAYS = [800, 1600, 3200, 6400, 8000];

/** 连续失败到这么多轮就通知上层降级（窗口观察器接管状态推算），但不停止重连。 */
const GIVE_UP_AFTER = 5;

/** SSE 静默超过这么久就去 `/v1/health` 探一次（服务端不一定发 ping）。 */
const HEARTBEAT_IDLE_MS = 20000;
const HEARTBEAT_TICK_MS = 5000;
/** 心跳连挂两轮才认定「半死」，避免一次抖动就断线重来。 */
const HEARTBEAT_MAX_FAILS = 2;

function localAppData() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
}

/**
 * `bridge.json` 的候选路径。
 *
 * ★ 优先级不是随便排的：
 *   ① 调用方显式指定（测试 / 用户手填 `bridgeFile`）；
 *   ② 环境变量 `DSH_RESTNOW_BRIDGE`；
 *   ③ **歇会儿 config.json 的同目录** —— 唯一「推导」出来的那条，最可靠。
 *      源码直跑时数据目录 = 程序目录，④⑤⑥ 一个都命中不了，只有这条能中
 *      （2026-11-07 实测：先开 DSH 后开歇会儿，日志只有 `bridge not available`）；
 *   ④ MSIX 包私有区；⑤ 漫游；⑥ 本地。
 */
function bridgeCandidates(explicit, configDir) {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (explicit) push(explicit);
  push(process.env.DSH_RESTNOW_BRIDGE);
  if (configDir) push(join(configDir, 'bridge.json'));

  const packagesDir = join(localAppData(), 'Packages');
  if (existsSync(packagesDir)) {
    try {
      for (const d of readdirSync(packagesDir)) {
        if (!/^RestNow\./i.test(d)) continue;
        push(join(packagesDir, d, 'LocalCache', 'Roaming', 'RestNow', 'bridge.json'));
        push(join(packagesDir, d, 'LocalState', 'bridge.json'));
      }
    } catch {
      /* 目录不可读就跳过 */
    }
  }
  push(join(roamingAppData(), 'RestNow', 'bridge.json'));
  push(join(localAppData(), 'RestNow', 'bridge.json'));
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM：进程存在但无权信号（跨用户），仍算活着
    return Boolean(e && e.code === 'EPERM');
  }
}

function httpJson({ port, path, method = 'GET', body, token, timeoutMs = DEFAULT_TIMEOUT }) {
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
    if (token) headers.authorization = 'Bearer ' + token;
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
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers, timeout: timeoutMs },
      (res) => {
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
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

export class BridgeClient {
  constructor(cfg = {}, hooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;               // { onEvent, onDown, onUp, log, getConfigPath }
    this.port = 0;
    this.token = '';
    this.pid = 0;
    this.descriptor = '';
    this.appVersion = '';
    this.connected = false;
    this.degraded = false;            // 连续重连失败 ⇒ true（上层已降级），仍继续重连
    this.started = false;
    this.stopped = false;
    this.req = null;
    this.buf = '';
    this.lastSeq = 0;
    this.retries = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastSeenAt = 0;              // 最近一次从 SSE 收到任何字节的时间
    this.healthFails = 0;
    this.probeTries = 0;
    this.probeAt = 0;
    this.probeError = '';
    this.stats = { events: 0, actions: 0, failures: 0, reconnects: 0, lastEvent: null, lastError: null };
  }

  _log(level, msg, extra) {
    if (this.hooks.log) this.hooks.log(level, msg, extra);
  }

  /** 歇会儿数据目录（由上层注入 config.json 的路径后推导）。 */
  configDir() {
    try {
      const p = this.hooks.getConfigPath ? this.hooks.getConfigPath() : '';
      return p ? dirname(p) : '';
    } catch {
      return '';
    }
  }

  /** 找到 bridge.json 并验活。返回 true 表示可以走事件流。 */
  async probe() {
    this.probeTries += 1;
    this.probeAt = Date.now();
    this.probeError = '';
    for (const path of bridgeCandidates(this.cfg.bridgeFile, this.configDir())) {
      if (!existsSync(path)) continue;
      const desc = readJson(path);
      if (!desc || !desc.port || !desc.token) {
        this.probeError = `bad-descriptor:${path}`;
        continue;
      }
      if (desc.pid && !pidAlive(desc.pid)) {
        // 进程已经没了，文件是残留：别报错，继续找下一个
        this.probeError = `stale-pid:${desc.pid}`;
        continue;
      }
      const r = await httpJson({ port: desc.port, path: '/v1/health', timeoutMs: 900 });
      if (!r.ok || !r.json || !r.json.ok) {
        this.probeError = `health-fail:${desc.port}:${r.error || r.status || 'no-body'}`;
        continue;
      }
      const changed = this.port !== Number(desc.port) || this.token !== String(desc.token);
      this.port = Number(desc.port);
      this.token = String(desc.token);
      this.pid = Number(desc.pid) || 0;
      this.descriptor = path;
      this.appVersion = String(desc.appVersion || r.json.appVersion || '');
      // ★ 首次连接不要历史回放：服务端会把缓冲区里的几百条旧事件一次性补发，
      //   桌宠就会连着做一堆早就过期的动作（DSH 每次重启都演一遍，2026-11-07 实测）。
      //   先取 /v1/snapshot 的 seq 当基线，连接时带 `last-event-id` ⇒ 只补这之后的新事件。
      //   ★ 但**换了一个新的歇会儿进程**时必须重取基线：新进程的 seq 从 0 重新数，
      //   沿用旧的大数值会让它以为「你都看到了」而不再补发，等于丢事件。
      const snap = await httpJson({
        port: this.port, path: '/v1/snapshot', token: this.token, timeoutMs: 1200,
      });
      const baseSeq = Number(snap && snap.json && snap.json.seq) || 0;
      if (changed || baseSeq > 0) this.lastSeq = baseSeq;
      this._log('info', 'bridge probed', {
        port: this.port, appVersion: this.appVersion, path, baseSeq, changed,
      });
      // ★ 端口 / token 换了（歇会儿重启过）⇒ 手里那条 SSE 还连在**旧**端口上，
      //   它不会自己报错（旧进程早没了，socket 可能已经半死），必须主动断掉重连。
      //   不做这一步的表现：日志一切正常、`available` 为 true，但一个事件都收不到。
      if (changed && this.started) this.reconnectNow('descriptor-changed');
      return true;
    }
    this._log('warn', 'bridge not available (旧版歇会儿或未启动)', {
      tried: bridgeCandidates(this.cfg.bridgeFile, this.configDir()).length,
      configDir: this.configDir() || null,
      why: this.probeError || 'no-descriptor',
    });
    return false;
  }

  /** 建立 SSE 长连接；断线按退避重连，连续失败通知 onDown（但不停止重连）。 */
  start() {
    if (this.stopped) return;
    if (this.started) return;
    this.started = true;
    this._connect();
    this._startHeartbeat();
  }

  _connect() {
    if (this.stopped) return;
    const headers = { authorization: 'Bearer ' + this.token, accept: 'text/event-stream' };
    if (this.lastSeq > 0) headers['last-event-id'] = String(this.lastSeq);
    let settled = false;
    const req = httpGet(
      { host: '127.0.0.1', port: this.port, path: '/v1/events', headers, timeout: 0 },
      (res) => {
        if (res.statusCode !== 200) {
          settled = true;
          this.stats.failures += 1;
          this._log('warn', 'sse rejected', { status: res.statusCode });
          res.resume();
          this._scheduleReconnect();
          return;
        }
        this.connected = true;
        this.retries = 0;
        this.healthFails = 0;
        this.lastSeenAt = Date.now();
        const wasDegraded = this.degraded;
        this.degraded = false;
        if (this.hooks.onUp) this.hooks.onUp(this.snapshot());
        this._log('info', wasDegraded ? 'sse connected (recovered)' : 'sse connected', { port: this.port });
        res.setEncoding('utf8');
        res.on('data', (chunk) => this._feed(chunk));
        res.on('end', () => {
          this.connected = false;
          if (!this.stopped) {
            this.stats.reconnects += 1;
            this._scheduleReconnect();
          }
        });
        res.on('error', () => {
          this.connected = false;
          if (!this.stopped) this._scheduleReconnect();
        });
      },
    );
    this.req = req;
    req.on('error', (e) => {
      this.connected = false;
      this.stats.lastError = String((e && e.message) || e);
      if (!settled && !this.stopped) this._scheduleReconnect();
    });
  }

  /* ---------------- 心跳 ---------------- */

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    // 间隔/阈值可以从 cfg 覆盖（回归脚本要把 20 秒压到 1 秒内）
    const tick = Number(this.cfg.heartbeatTickMs) || HEARTBEAT_TICK_MS;
    this.heartbeatTimer = setInterval(() => {
      this._heartbeat().catch(() => {});
    }, tick);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * SSE 半死的检测。
   * ★ 为什么必须要：socket 可以「看起来连着」但服务端进程已经卡死 / 被挂起，
   *   这时 on('end') 不会触发，请求也不会报错，桌宠就一直等着一个永远不会来的事件。
   *   有没有事件都可能静默很久（45 分钟才弹一次），所以先看静默时长，再用
   *   `/v1/health`（免鉴权、开销极小）分辨「真没事件」还是「桥已经死了」。
   */
  async _heartbeat() {
    if (this.stopped || !this.connected) return;
    const idleThreshold = Number(this.cfg.heartbeatIdleMs) || HEARTBEAT_IDLE_MS;
    const idle = Date.now() - this.lastSeenAt;
    if (idle < idleThreshold) {
      this.healthFails = 0;
      return;
    }
    const r = await httpJson({ port: this.port, path: '/v1/health', timeoutMs: 1200 });
    if (r.ok && r.json && r.json.ok) {
      // 桥活着，只是这段时间没事件：把基线推到「现在」，别每 5 秒问一次
      this.lastSeenAt = Date.now();
      this.healthFails = 0;
      return;
    }
    this.healthFails += 1;
    this._log('warn', 'sse heartbeat failed', {
      silentMs: idle, fails: this.healthFails, error: r.error || r.status,
    });
    if (this.healthFails >= HEARTBEAT_MAX_FAILS) {
      this.healthFails = 0;
      this._forceReconnect('heartbeat');
    }
  }

  _forceReconnect(why) {
    this.connected = false;
    this.stats.reconnects += 1;
    this.stats.lastError = 'heartbeat-timeout';
    this._log('warn', 'sse reconnect forced', { why });
    if (this.req) {
      try {
        this.req.destroy();
      } catch {
        /* ignore */
      }
      this.req = null;
    }
    this._scheduleReconnect();
  }

  /**
   * 立刻丢掉现有连接、按新地址重连（描述文件变了 / 心跳判定半死 / 用户手点重连）。
   * ★ 不复位 `started`：这个客户端本来就该一直活着，只是换一条 socket。
   */
  reconnectNow(why = 'manual') {
    if (this.stopped) return;
    this.started = true;
    this.retries = 0;
    this.healthFails = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._forceReconnect(why);
  }

  _feed(chunk) {
    // ★ 任何字节都算「桥还活着」——包括 `: ping` 注释行
    this.lastSeenAt = Date.now();
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      let data = '';
      let id = 0;
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) data += line.slice(6);
        else if (line.startsWith('id: ')) id = Number(line.slice(4)) || 0;
      }
      if (!data) continue;                       // ": ping" / ": connected"
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (id > 0) this.lastSeq = Math.max(this.lastSeq, id);
      this.stats.events += 1;
      this.stats.lastEvent = payload;
      if (this.hooks.onEvent) {
        try {
          this.hooks.onEvent(payload);
        } catch (e) {
          this._log('warn', 'event handler threw', { error: String((e && e.message) || e) });
        }
      }
    }
    if (this.buf.length > 200000) this.buf = '';  // 防御：异常数据别把内存撑爆
  }

  /**
   * 重连排期。
   * ★ **永不放弃** —— 本地回环连接，8 秒一次的尝试成本可以忽略；
   *   老实现失败 5 轮就 `started = false` 彻底停手，歇会儿重启慢一点（装更新、
   *   杀软扫描）就连不回来了，只剩上层那个 10 秒轮询兜底（最多晚 10 秒）。
   *   ★ 但到阈值要通知上层**降级**：让窗口观察器接管状态推算，
   *     不能因为桥断了就连「休息开始了」都收不到。
   */
  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(this.retries, RECONNECT_DELAYS.length - 1)];
    this.retries += 1;
    if (this.retries === GIVE_UP_AFTER && !this.degraded && this.hooks.onDown) {
      this.degraded = true;
      this._log('warn', 'sse degraded（继续重连，同时通知上层降级）', { retries: this.retries });
      this.hooks.onDown();
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  /** 下发一个动作。歇会儿侧按 type 白名单校验，非法会返回 400。 */
  async action(type, args, opts = {}) {
    const r = await this._actionOnce(type, args, opts);
    if (r.ok) return r;
    // ★ 歇会儿重启过 ⇒ 端口和 token 全变了。401 / 连不上这类「可达性」错误
    //   重新找一遍描述文件再试一次；业务错误（400 参数不合法）不重试，
    //   重试也不会变好，只会把同一个错误报两遍。
    const transient = !r.status || r.status === 401 || r.status === 403
      || r.status === 502 || r.status === 503;
    if (!transient) return r;
    const ok = await this.probe();
    if (!ok) return r;
    this._log('info', 'bridge re-probed, retrying action', { type, port: this.port });
    return this._actionOnce(type, args, opts);
  }

  async _actionOnce(type, args, { id, timeoutMs = 3200 } = {}) {
    if (!this.port || !this.token) {
      const ok = await this.probe();
      if (!ok) return { ok: false, error: 'bridge-unavailable' };
    }
    const body = {
      v: 1,
      type,
      args: args || {},
      issued_by: 'dsh-pet-restnow',
      ts: Date.now() / 1000,
    };
    if (id) body.id = id;
    else body.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await httpJson({
      port: this.port,
      path: '/v1/action',
      method: 'POST',
      body,
      token: this.token,
      timeoutMs,
    });
    if (!r.ok || !r.json) {
      this.stats.failures += 1;
      this.stats.lastError = r.error || `http-${r.status}`;
      return { ok: false, error: this.stats.lastError, status: r.status };
    }
    this.stats.actions += 1;
    return r.json;
  }

  /**
   * 只探活，不改 port/token/lastSeq、不断 SSE。
   * ★ snapshot().available 只说明「读到过描述文件」：歇会儿退出后 port/token 会残留，
   *   用它判断「程序在不在跑」会把自动拉起整段跳过（2026-11-07 真机实证）。
   */
  async ping(timeoutMs = 900) {
    if (!this.port || !this.token) return false;
    const r = await httpJson({ port: this.port, path: '/v1/health', token: this.token, timeoutMs });
    return Boolean(r.ok && r.json && r.json.ok);
  }

  async snapshotDeep() {
    if (!this.port || !this.token) return null;
    const r = await httpJson({ port: this.port, path: '/v1/snapshot', token: this.token, timeoutMs: 1500 });
    return r.ok ? r.json : null;
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.req) {
      try {
        this.req.destroy();
      } catch {
        /* ignore */
      }
      this.req = null;
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      available: Boolean(this.port && this.token),
      connected: this.connected,
      degraded: this.degraded,
      port: this.port,
      appVersion: this.appVersion,
      descriptor: this.descriptor,
      descriptorAt: this.descriptor ? safeMtime(this.descriptor) : 0,
      lastSeq: this.lastSeq,
      silentMs: this.lastSeenAt ? now - this.lastSeenAt : null,
      retries: this.retries,
      probeTries: this.probeTries,
      probeAgoMs: this.probeAt ? now - this.probeAt : null,
      probeError: this.probeError,
      configDir: this.configDir() || null,
      ...this.stats,
    };
  }
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export const _internal = { bridgeCandidates, pidAlive, readJson };
