// 右键菜单 + 自动拉起歇会儿 的单测。
// 不连真实桌宠、不真起 GUI：用替身驱动 Engine 的方法。
import { _internal } from '../lib/index.js';

const { Engine, resolveRestNowLauncher } = _internal;

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const tick = () => new Promise((r) => setImmediate(r));

function makeCfg(over = {}) {
  return {
    enabled: true, surface: 'desktop', petId: '', petPort: 0, bridgePort: 47110,
    watchWindows: false, pollMs: 2000, throttleMs: 10000, announceBreak: true,
    announcePomo: true, raisePetOnBreak: true, enablePetMenu: true,
    autoLaunchRestNow: true, restnowLauncher: '',
    useBridge: false, accompany: true, petTitle: 'dsh-pet', ...over,
  };
}

function makeEngine(over = {}) {
  const e = new Engine(makeCfg(over));
  e.calls = [];
  e.registers = 0;
  e.unregisters = 0;
  e.says = [];
  e.notices = [];
  e.pet = {
    registerMenu: async () => { e.registers++; return true; },
    unregisterMenu: async () => { e.unregisters++; return true; },
    pollMenu: async () => ({}),
    say: async (t) => { e.says.push(t); return true; },
  };
  e.notice = (t) => { e.notices.push(t); };
  e.petAction = async (type, args) => { e.calls.push({ type, args }); return { ok: true }; };
  return e;
}

/** 拉起专用引擎：bridge / 进程查询 / 启动器 / spawn 全部替身。 */
function makeLaunchEngine(over = {}) {
  const e = makeEngine(over);
  e.notices = [];
  e.notice = (t) => { e.notices.push(t); };
  delete e.petAction;                       // 用真实 petAction
  e.bridgeCalls = [];
  e.spawned = [];
  e.bridge = {
    pid: 0,
    available: false,
    snapshot: () => ({ available: e.bridge.available }),
    probe: async () => e.bridge.available,
    ping: async () => e.bridge.available,   // 1.4.6 起 petAction 先做真 HTTP 探活
    start: () => { e.bridgeStarts = (e.bridgeStarts || 0) + 1; },
    snapshotDeep: async () => null,
    action: async (type, args) => { e.bridgeCalls.push({ type, args }); return { ok: true }; },
  };
  e.launchDeps = {
    findPid: async () => 0,
    resolveLauncher: async () => ({ kind: 'exe', target: 'C:\\fake\\RestNow.exe' }),
    spawn: (file, args) => { e.spawned.push({ file, args }); return { unref() {} }; },
  };
  e.waitBridgeReady = async () => { e.bridge.available = true; return true; };
  return e;
}

async function main() {
  // ── 1. 菜单分发：六项各对应正确动作（含三档专注） ──────────────
  {
    const e = makeEngine();
    const labels = Object.keys(e.MENU_ACTIONS);
    for (const l of labels) e.onMenuClick(l, 'pet1');
    await tick();
    const types = e.calls.map((c) => c.type);
    ck('点击「立即休息」→ rest_now', types.includes('rest_now'));
    ck('三档专注都在菜单里',
      labels.includes('开始专注25min(番茄钟)') && labels.includes('开始专注35min(番茄钟)')
      && labels.includes('开始专注45min(番茄钟)'));
    for (const m of [25, 35, 45]) {
      ck(`专注 ${m}min → start_focus 且 minutes=${m}`,
        e.calls.some((c) => c.type === 'start_focus' && c.args.minutes === m));
    }
    ck('三档专注的气泡各自带正确分钟数',
      ['25 分钟', '35 分钟', '45 分钟'].every((s) => e.notices.some((t) => t.includes(s))),
      { notices: e.notices });
    ck('点击「暂停/恢复提醒」→ toggle_pause', types.includes('toggle_pause'));
    ck('点击「延后5分钟」→ snooze 且 5 分钟',
      e.calls.some((c) => c.type === 'snooze' && c.args.minutes === 5));
    ck('每次点击都有中性即时回执', e.notices.filter((t) => t === '收到～').length === labels.length);
    const before = e.calls.length;
    e.onMenuClick('不存在的项', 'pet1');
    await tick();
    ck('未知标签被忽略', e.calls.length === before);
  }

  // ── 1b. 注册契约：dsh-pet 侧硬上限 ITEMS_MAX=20 / LABEL_MAX=32 ──
  {
    const e = makeEngine();
    const labels = Object.keys(e.MENU_ACTIONS);
    ck('菜单项数不超过 ITEMS_MAX(20)', labels.length <= 20, { count: labels.length });
    ck('每项标签不超过 LABEL_MAX(32)', labels.every((l) => l.length <= 32),
      { max: Math.max(...labels.map((l) => l.length)) });
    ck('标签无重复', new Set(labels).size === labels.length);
    ck('owner 非空且不超过 OWNER_MAX(64)',
      e.MENU_OWNER.length > 0 && e.MENU_OWNER.length <= 64);
  }

  // ── 2. 长轮询循环：unknown-owner 后自愈重注册并分发 ────────────
  {
    const e = makeEngine();
    let pollN = 0;
    e.pet.pollMenu = async () => {
      pollN++;
      if (pollN === 1) return null;
      return { '立即休息': 'petX' };
    };
    e.petAction = async (type, args) => { e.calls.push({ type, args }); e._menuStop = true; return { ok: true }; };
    await e.runMenuLoop();
    ck('unknown-owner 后重注册（registers≥2）', e.registers >= 2, { registers: e.registers });
    ck('循环内点击被分发为 rest_now', e.calls.some((c) => c.type === 'rest_now'));
    ck('循环正常退出（_menuLoopRunning=false）', e._menuLoopRunning === false);
  }

  // ── 3. 退出清理：stopMenuLoop 注销菜单 ─────────────────────────
  {
    const e = makeEngine();
    e.stopMenuLoop();
    ck('stopMenuLoop 调用 unregisterMenu', e.unregisters === 1, { unregisters: e.unregisters });
    ck('stopMenuLoop 置 _menuStop', e._menuStop === true);
  }

  // ── 4. 菜单开关关闭时不注册 ───────────────────────────────────
  {
    const e = makeEngine({ enablePetMenu: false });
    const ok = await e.registerPetMenu();
    ck('enablePetMenu=false 时 registerPetMenu 返回 false', ok === false);
    ck('关闭时不会调用 pet.registerMenu', e.registers === 0, { registers: e.registers });
  }

  // ── 5. 自动拉起：歇会儿没开 → 启动 → 执行动作 ─────────────────
  {
    const e = makeLaunchEngine();
    const r = await e.petAction('start_focus', { minutes: 35 });
    ck('未运行时自动拉起且动作执行成功', r && r.ok === true, r);
    ck('返回值带 launched=true', r && r.launched === true);
    ck('只 spawn 一次安装版 exe', e.spawned.length === 1 && e.spawned[0].file.includes('RestNow.exe'),
      { spawned: e.spawned });
    ck('1.4.6：启动参数带 --startup（只出番茄钟、不亮主界面）',
      Array.isArray(e.spawned[0].args) && e.spawned[0].args.includes('--startup'),
      { args: e.spawned[0].args });
    ck('1.4.6：自动拉起后接上 SSE', e.bridgeStarts === 1, { starts: e.bridgeStarts });
    ck('动作真的转发给歇会儿', e.bridgeCalls.some((c) => c.type === 'start_focus' && c.args.minutes === 35));
    ck('有「正在启动」提示', e.notices.some((t) => t.includes('启动一下')));
    ck('有「已就绪」提示', e.notices.some((t) => t.includes('已就绪')));
    ck('统计 launches +1', e.stats.launches === 1);
  }

  // ── 6. 未安装：不 spawn，明确提示安装 ─────────────────────────
  {
    const e = makeLaunchEngine();
    e.launchDeps.resolveLauncher = async () => null;
    const r = await e.petAction('rest_now', {});
    ck('未安装返回 restnow-not-installed', r && r.error === 'restnow-not-installed', r);
    ck('未安装时不 spawn', e.spawned.length === 0);
    ck('气泡提醒用户安装', e.notices.some((t) => t.includes('请先安装')), { notices: e.notices });
    ck('未安装时动作不转发', e.bridgeCalls.length === 0);
  }

  // ── 7. 进程已在跑（只是桥抖）：不 spawn 第二个，只等桥恢复 ────
  {
    const e = makeLaunchEngine();
    e.launchDeps.findPid = async () => 12345;
    const r = await e.petAction('toggle_pause', {});
    ck('进程在跑时动作仍成功', r && r.ok === true, r);
    ck('进程在跑时不重复启动', e.spawned.length === 0, { spawned: e.spawned });
    ck('进程在跑时 launched=false', r && r.launched === false);
  }

  // ── 8. 等桥超时：明确报超时而不是假装成功 ─────────────────────
  {
    const e = makeLaunchEngine();
    e.waitBridgeReady = async () => false;
    const r = await e.petAction('snooze', { minutes: 5 });
    ck('等桥超时返回 restnow-launch-timeout', r && r.error === 'restnow-launch-timeout', r);
    ck('超时时动作不转发', e.bridgeCalls.length === 0);
    ck('超时有「稍后再点一次」提示', e.notices.some((t) => t.includes('稍后再点')));
  }

  // ── 9. 开关关闭 → 维持旧行为（只提示，不自动启动） ────────────
  {
    const e = makeLaunchEngine({ autoLaunchRestNow: false });
    const r = await e.petAction('rest_now', {});
    ck('autoLaunchRestNow=false 返回 restnow-not-running', r && r.error === 'restnow-not-running', r);
    ck('关闭时不 spawn', e.spawned.length === 0);
  }

  // ── 10. 并发点两次只拉起一次 ──────────────────────────────────
  {
    const e = makeLaunchEngine();
    e.waitBridgeReady = async () => { await new Promise((r) => setTimeout(r, 20)); e.bridge.available = true; return true; };
    await Promise.all([e.petAction('rest_now', {}), e.petAction('toggle_pause', {})]);
    ck('并发两次只 spawn 一次', e.spawned.length === 1, { spawned: e.spawned.length });
    ck('两个动作都执行了', e.bridgeCalls.length === 2, { calls: e.bridgeCalls.length });
  }

  // ── 11. waitBridgeReady 真实重试逻辑 ──────────────────────────
  {
    const e = makeLaunchEngine();
    delete e.waitBridgeReady;                 // 用真实实现
    let n = 0;
    e.bridge.probe = async () => { n++; return n >= 3; };
    const ok = await e.waitBridgeReady(5000);
    ck('桥第 3 次探测成功 → waitBridgeReady 返回 true', ok === true, { probes: n });
    ck('确实重试过（probe ≥3）', n >= 3, { probes: n });
  }

  // ── 12. 启动器选择：商店版 / 安装版 / 显式指定 ────────────────
  {
    const probe = async () => ({
      EXE: 'C:\\Users\\x\\AppData\\Local\\RestNow\\RestNow.exe',
      APPID: 'RestNow.RestNow_abc!RestNow',
      FALLBACK: 'C:\\Users\\x\\AppData\\Local\\RestNow\\RestNow.exe',
    });
    const storeCfg = 'C:\\Users\\x\\AppData\\Local\\Packages\\RestNow.RestNow_abc\\LocalCache\\Roaming\\RestNow\\config.json';
    const localCfg = 'C:\\Users\\x\\AppData\\Roaming\\RestNow\\config.json';
    const s = await resolveRestNowLauncher({}, storeCfg, probe);
    const l = await resolveRestNowLauncher({}, localCfg, probe);
    ck('活跃 config 在 Packages 下 → 选商店版 AppID', s.kind === 'appid' && s.target.includes('!'), s);
    ck('活跃 config 在 Roaming 下 → 不会错装商店版',
      !(l.kind === 'exe' && l.target.includes('Packages')), l);
    const x = await resolveRestNowLauncher({ restnowLauncher: 'D:\\mine\\RestNow.exe' }, '', probe);
    ck('显式指定 exe 最优先', x.kind === 'exe' && x.target === 'D:\\mine\\RestNow.exe', x);
    const x2 = await resolveRestNowLauncher({ restnowLauncher: 'shell:AppsFolder\\PFN!App' }, '', probe);
    ck('显式指定 AppID 能识别', x2.kind === 'appid' && x2.target === 'PFN!App', x2);
  }

  console.log(`\n菜单 + 自动拉起测试：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST-CRASH', e); process.exit(2); });
