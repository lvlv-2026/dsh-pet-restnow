// 1.4.6 自动拉起回归：启动器探针语法、--startup 参数、状态与所点命令一致。
// ★ 不真起 GUI、不连真实桌宠：spawn / 进程查询 / 桥全部是替身。
// ★ 两组「正控」必须能复现旧 bug：① 旧 PowerShell 拼接脚本确实解析失败；
//   ② 关掉 launchTomatoOnly 后 argv 里确实没有 --startup（会亮主界面）。
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { _internal } from '../lib/index.js';

const {
  Engine, buildLaunchProbeScript, buildLaunchCommand, STARTUP_ARG, findPwsh,
} = _internal;

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

function makeCfg(over = {}) {
  return {
    enabled: true, surface: 'desktop', petId: '', petPort: 0, bridgePort: 47110,
    watchWindows: false, pollMs: 2000, throttleMs: 10000, announceBreak: true,
    announcePomo: true, raisePetOnBreak: true, enablePetMenu: true,
    autoLaunchRestNow: true, restnowLauncher: '', launchTomatoOnly: true,
    launchSettleMs: 0, useBridge: false, accompany: true, petTitle: 'dsh-pet',
    ...over,
  };
}

function makeEngine(over = {}) {
  const e = new Engine(makeCfg(over));
  e.notices = [];
  e.spawned = [];
  e.bridgeCalls = [];
  e.bridgeStarts = 0;
  e.notice = (t) => { e.notices.push(t); };
  e.pet = {
    registerMenu: async () => true,
    unregisterMenu: async () => true,
    pollMenu: async () => ({}),
    say: async () => true,
    snapshot: () => ({}),
  };
  e.bridge = {
    pid: 0, port: 47110, token: 't', appVersion: '1.0.9.0', connected: false,
    available: false,
    configDir: () => null,
    snapshot: () => ({ available: e.bridge.available }),
    ping: async () => false,
    probe: async () => false,
    start: () => { e.bridgeStarts += 1; },
    snapshotDeep: async () => ({ screen: { w: 1920, h: 1080 }, tomato_probe: { visible: true }, tomato: { x: 10, y: 10, w: 100, h: 100 } }),
    action: async (type, args) => { e.bridgeCalls.push({ type, args }); return { ok: true }; },
    ...(over.bridgeStub || {}),
  };
  e.launchDeps = {
    findPid: async (hint) => { e.findPidHints = (e.findPidHints || []).concat(hint); return 0; },
    resolveLauncher: async () => ({ kind: 'exe', target: 'C:\\fake\\RestNow\\RestNow.exe' }),
    spawn: (file, args, opts) => { e.spawned.push({ file, args, opts }); return { unref() {} }; },
  };
  e.waitBridgeReady = async () => true;
  return e;
}

/** 用 PowerShell 自己的 Parser 做语法检查：不执行脚本、不依赖本机装没装歇会儿。 */
function psParse(script) {
  return new Promise((resolve) => {
    const code = '$s=[Console]::In.ReadToEnd();$e=$null;'
      + '[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$null,[ref]$e)|Out-Null;'
      + "if($e.Count){'PARSE-ERROR: '+$e[0].Message}else{'PARSE-OK'}";
    let out = '', err = '', settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let ps;
    try {
      ps = spawn(findPwsh(), ['-NoProfile', '-NonInteractive', '-Command', code],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (ex) { done('SPAWN-FAILED: ' + String(ex)); return; }
    ps.stdout.on('data', (c) => (out += c.toString('utf8')));
    ps.stderr.on('data', (c) => (err += c.toString('utf8')));
    ps.on('error', (ex) => done('SPAWN-FAILED: ' + String(ex)));
    ps.on('exit', () => done((out + '\n' + err).trim()));
    ps.stdin.end(Buffer.from(script, 'utf8'));
    setTimeout(() => { try { ps.kill(); } catch {} done('TIMEOUT'); }, 12000);
  });
}

async function main() {
  // ── A. 启动器探针脚本（1.4.4 恒判「未安装」的根因） ──────────────
  {
    const s = buildLaunchProbeScript();
    ck('探针含三处注册表根', (s.match(/HKCU:\\Software|HKLM:\\Software/g) || []).length >= 3, s);
    ck('$roots 一行写完（没有 ,; 这种拼接残骸）', !/,;/.test(s) && /\$roots = @\('[^']+', '[^']+', '[^']+'\)/.test(s), s);
    ck('DisplayName 用前缀匹配 歇会儿*', s.includes("-like '歇会儿*'"), s);
    ck('要求 DisplayIcon 非空', s.includes('$_.DisplayIcon'), s);
    ck('AppID 只采信带 ! 的商店版', s.includes("-like '*!*'"), s);
    ck('带 FALLBACK 默认安装目录',
      s.includes('FALLBACK=') && s.includes('Join-Path $env:LOCALAPPDATA')
      && /RestNow[\\/]{1,2}RestNow\.exe/.test(s), s);
    ck('脚本不含换行（; 拼接不会断句）', !/[\r\n]/.test(s));

    const good = await psParse(s);
    ck('★ PowerShell 真解析器：当前脚本语法通过', good.includes('PARSE-OK'), good.slice(0, 300));
    // 正控：把 $roots 按 1.4.4 那样拆成三条语句（`@('A',; 'B',; 'C')`），
    // 必须被解析器判红 —— 证明「恒判未安装」的根因不是想象出来的。
    const roots = (/\$roots = @\(([^)]*)\)/.exec(s) || [])[1];
    const parts = roots ? roots.split("', '").map((x) => x.replace(/^'|'$/g, '')) : [];
    const broken = parts.length === 3
      ? s.replace(/\$roots = @\([^)]*\)/,
          `$roots = @('${parts[0]}',; '${parts[1]}',; '${parts[2]}')`)
      : '$roots = @(\'A\',; \'B\',; \'C\')';
    const bad = await psParse(broken);
    ck('★ 正控：旧式拆行脚本会被 PowerShell 判语法错', bad.includes('PARSE-ERROR'), { broken: broken.slice(0, 220), bad: bad.slice(0, 220) });
  }

  // ── B. 启动命令构造（只出番茄钟的核心） ─────────────────────────
  {
    const exe = { kind: 'exe', target: 'C:\\fake\\RestNow\\RestNow.exe' };
    const msix = { kind: 'appid', target: 'RestNow.RestNow_abc!RestNow' };
    const a = buildLaunchCommand(exe, { tomatoOnly: true });
    ck('安装版：command = exe 绝对路径', a.command === exe.target);
    ck('安装版：argv 恰好是 ["--startup"]',
      a.args.length === 1 && a.args[0] === STARTUP_ARG && STARTUP_ARG === '--startup', a.args);
    ck('安装版：cwd 指向 exe 所在目录', a.opts.cwd === 'C:\\fake\\RestNow', a.opts.cwd);
    ck('安装版：detached + windowsHide', a.opts.detached === true && a.opts.windowsHide === true);
    ck('安装版：tomatoOnly=true / degraded=false', a.tomatoOnly === true && a.degraded === false);
    const b = buildLaunchCommand(exe, { tomatoOnly: false });
    ck('★ 正控：关掉开关后 argv 为空（旧行为＝会亮主界面）', b.args.length === 0 && b.reason === 'exe-normal', b);
    const c = buildLaunchCommand(msix, { tomatoOnly: true });
    ck('商店版：走 explorer.exe + shell:AppsFolder', c.command === 'explorer.exe' && c.args[0].startsWith('shell:AppsFolder\\'), c.args);
    ck('商店版：不假装做到了（degraded=true / tomatoOnly=false）', c.degraded === true && c.tomatoOnly === false, c);
    ck('商店版：argv 里绝不硬塞 --startup', !c.args.includes('--startup'), c.args);
    const d = buildLaunchCommand(msix, { tomatoOnly: false });
    ck('商店版：没要求静默时不算降级', d.degraded === false);
    ck('空启动器返回 null', buildLaunchCommand(null) === null && buildLaunchCommand({ kind: 'exe' }) === null);
  }

  // ── C. 1.4.5 的「已安装未启动」假存活：available 残留也必须拉起 ──
  {
    const e = makeEngine();
    e.bridge.available = true;      // 读到过描述文件（port/token 残留）
    e.bridge.pid = 38628;           // 上一次 probe 的僵尸 pid
    const r = await e.petAction('start_focus', { minutes: 25 });
    ck('stale available=true 仍判定未启动并拉起', e.spawned.length === 1 && r.launched === true,
      { spawned: e.spawned.length, r });
    ck('findPid 传 0 强制实查（没拿残留 pid 当 hint）',
      (e.findPidHints || []).every((h) => h === 0) && e.findPidHints.length >= 1, e.findPidHints);
    ck('拉起时带 --startup', e.spawned[0].args.includes('--startup'), e.spawned[0].args);
    ck('原始命令原样重发（25 分钟）',
      e.bridgeCalls.some((c) => c.type === 'start_focus' && c.args.minutes === 25), e.bridgeCalls);
    ck('拉起后接上 SSE', e.bridgeStarts === 1, { starts: e.bridgeStarts });
    ck('status().launchMode 记录本次启动',
      (await e.status(false)).launchMode.tomatoOnly === true, (await e.status(false)).launchMode);
    const st = await e.status(false);
    ck('status().launchMode.last 带 argv 与动作',
      st.launchMode.last && st.launchMode.last.args.includes('--startup')
      && st.launchMode.last.action === 'start_focus', st.launchMode.last);
  }

  // ── D. 六项右键菜单：启动后番茄钟状态必须与所点命令一致 ─────────
  {
    const expect = {
      '立即休息': ['rest_now', {}],
      '开始专注25min(番茄钟)': ['start_focus', { minutes: 25 }],
      '开始专注35min(番茄钟)': ['start_focus', { minutes: 35 }],
      '开始专注45min(番茄钟)': ['start_focus', { minutes: 45 }],
      '暂停/恢复提醒': ['toggle_pause', {}],
      '延后5分钟': ['snooze', { minutes: 5, reason: '来自桌宠右键菜单' }],
    };
    for (const [label, [type, args]] of Object.entries(expect)) {
      const e = makeEngine();
      await e.runMenuAction(e.MENU_ACTIONS[label]);
      ck(`菜单「${label}」→ 启动后立即重发 ${type}`,
        e.spawned.length === 1 && e.bridgeCalls.length === 1
        && e.bridgeCalls[0].type === type
        && JSON.stringify(e.bridgeCalls[0].args) === JSON.stringify(args),
        { spawned: e.spawned.length, calls: e.bridgeCalls });
      ck(`菜单「${label}」→ 启动带 --startup`,
        e.spawned.length === 1 && e.spawned[0].args.includes('--startup'), e.spawned);
    }
  }

  // ── E. 回执以歇会儿为准，不照抄菜单标签 ─────────────────────────
  {
    const e = makeEngine({
      bridgeStub: { action: async () => ({ ok: true, minutes: 45, next_at: '2026-11-07T17:00:00' }) },
    });
    await e.runMenuAction(e.MENU_ACTIONS['开始专注25min(番茄钟)']);
    ck('回执 minutes=45 时气泡显示 45 分钟（不是菜单上的 25）',
      e.notices.some((t) => t.includes('45 分钟')) && !e.notices.some((t) => t.includes('25 分钟')), e.notices);
    const p = makeEngine({ bridgeStub: { action: async () => ({ ok: true, paused: true }) } });
    await p.runMenuAction(p.MENU_ACTIONS['暂停/恢复提醒']);
    ck('toggle_pause 回执 paused=true → 文案说「已暂停」', p.notices.some((t) => t.includes('已暂停')), p.notices);
  }

  // ── F. settle 稳定期真的等过（番茄钟首帧摆位） ─────────────────
  {
    const e = makeEngine({ launchSettleMs: 90 });
    e.waitBridgeReady = async () => { e.readyAt = Date.now(); return true; };
    e.bridge.action = async (type, args) => {
      e.actionAt = Date.now();
      e.bridgeCalls.push({ type, args });
      return { ok: true };
    };
    await e.petAction('start_focus', { minutes: 35 });
    ck('下发动作前等过 launchSettleMs', e.actionAt - e.readyAt >= 80,
      { delta: e.actionAt - e.readyAt });
  }

  // ── G. 启动后首次动作失败：只对幂等命令补发一次 ─────────────────
  {
    const e = makeEngine();
    let n = 0;
    e.bridge.action = async (type, args) => {
      n += 1;
      e.bridgeCalls.push({ type, args });
      return n === 1 ? { ok: false, error: 'no-response' } : { ok: true, minutes: 25 };
    };
    const r = await e.petAction('start_focus', { minutes: 25 });
    ck('start_focus 首包丢失会补发一次并成功', r.ok === true && n === 2, { n, r });
    const p = makeEngine();
    let m = 0;
    p.bridge.action = async (type, args) => {
      m += 1;
      p.bridgeCalls.push({ type, args });
      return { ok: false, error: 'no-response' };
    };
    await p.petAction('toggle_pause', {});
    ck('toggle_pause 绝不补发（重发会把暂停翻回继续）', m === 1, { m });
  }

  // ── H. 商店 MSIX 降级：如实告知，动作照发 ────────────────────────
  {
    const e = makeEngine();
    e.launchDeps.resolveLauncher = async () => ({ kind: 'appid', target: 'RestNow.RestNow_abc!RestNow' });
    const r = await e.petAction('start_focus', { minutes: 45 });
    ck('商店版仍能把动作执行掉', r.ok === true && e.bridgeCalls.some((c) => c.args.minutes === 45), r);
    ck('商店版不传 --startup', e.spawned.length === 1 && !e.spawned[0].args.includes('--startup'), e.spawned);
    ck('商店版明确提示主界面会亮', e.notices.some((t) => t.includes('商店版') && t.includes('主界面')), e.notices);
    ck('返回值 degraded=true / tomatoOnly=false',
      r.degraded === true && r.tomatoOnly === false,
      { r, last: (await e.status(false)).launchMode.last });
  }

  // ── I. 判活 / 开关 / 并发 ───────────────────────────────────────
  {
    const e = makeEngine({ bridgeStub: { ping: async () => true } });
    const r = await e.petAction('rest_now', {});
    ck('ping 通则不启动第二个实例', r.ok === true && e.spawned.length === 0, e.spawned);
    ck('ping 通但没进过桥模式 → 也接上 SSE', e.bridgeStarts === 1, { starts: e.bridgeStarts });
    const f = makeEngine({ autoLaunchRestNow: false });
    const r2 = await f.petAction('rest_now', {});
    ck('autoLaunchRestNow=false 不启动', r2.error === 'restnow-not-running' && f.spawned.length === 0, r2);
    const g = makeEngine({ launchTomatoOnly: false });
    await g.petAction('start_focus', { minutes: 25 });
    ck('★ 正控：关掉 launchTomatoOnly 后确实没有 --startup',
      g.spawned.length === 1 && g.spawned[0].args.length === 0, g.spawned);
    ck('关掉后 status().launchMode.tomatoOnly=false', (await g.status(false)).launchMode.tomatoOnly === false);
  }

  // ── J. 静态守卫：旧判活写法不许回来 ─────────────────────────────
  {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    ck('petAction 用 ping()||probe() 判活', /await this\.bridge\.ping\(\)/.test(src) && /await this\.bridge\.probe\(\)/.test(src));
    ck('★ 反向守卫：代码里没有旧的 snapshot().available 判活',
      !/const alive\s*=\s*[^;]*snapshot\(\)\.available/.test(src));
    ck('★ 正控：守卫能抓到旧写法',
      /const alive\s*=\s*[^;]*snapshot\(\)\.available/.test("const alive = this.bridge.snapshot().available;"));
    ck('bridge-client 真的实现了 ping()', /async ping\(/.test(readFileSync(new URL('../lib/bridge-client.js', import.meta.url), 'utf8')));
  }

  console.log(`\n自动拉起 / 启动态测试：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST-CRASH', e); process.exit(2); });
