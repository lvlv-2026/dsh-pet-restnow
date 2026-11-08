// Web 控制台真 HTTP 冒烟：起真 server、打真 URL、断言最终动作。
// 覆盖：面板 / 功能清单 / 白名单 / 未开放功能被拒 / 口令 / 局域网绑定 / 动作转发。
import { _internal } from '../lib/index.js';
import { publicFeatures, buildRunArgs, WEB_FEATURE_GROUPS } from '../lib/web-panel.js';

const { startSurface } = _internal;

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

function fakeEngine() {
  const e = {
    calls: [],
    bridgeCalls: [],
    muted: false,
    status: async () => ({ ok: true, version: _internal.VERSION, bridge: { connected: true, available: true } }),
    simulate: (t) => { e.calls.push(['simulate', t]); return true; },
    setMuted: (on) => { e.muted = Boolean(on); return e.muted; },
    petAction: async (type, args) => { e.calls.push(['action', type, args]); return { ok: true, type, args }; },
    launchRestNow: async () => { e.calls.push(['launch']); return { ok: true, launched: true }; },
    bridge: {
      snapshot: () => ({ available: true, connected: true }),
      probe: async () => true,
      reconnectNow: () => {},
    },
    onBridgeUp: async () => {},
  };
  return e;
}

async function serve(cfg, engine) {
  const server = startSurface(engine, cfg);
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
    setTimeout(() => reject(new Error('listen timeout')), 4000);
  });
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const get = (url, headers = {}) => fetch(url, { headers });
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function main() {
  // ── 1. 功能清单本身的契约 ─────────────────────────────────────
  {
    const all = publicFeatures();
    ck('清单非空且分组齐全', all.length >= 20 && WEB_FEATURE_GROUPS.length >= 3, { count: all.length });
    ck('每个功能都有唯一 id', new Set(all.map((f) => f.id)).size === all.length);
    ck('三档专注都在清单里', ['focus_25', 'focus_35', 'focus_45'].every((id) => all.some((f) => f.id === id)));
    ck('危险功能「退出歇会儿」默认关闭', all.find((f) => f.id === 'quit_restnow').enabled === false);
    ck('所有功能都属于已声明分组', all.every((f) => WEB_FEATURE_GROUPS.includes(f.group)));
    ck('公开清单不含可执行字段（type/kind/key）',
      all.every((f) => !('type' in f) && !('kind' in f) && !('key' in f)));
  }

  // ── 2. 白名单翻译（正控：未开放 / 不存在的 id 必须被拒） ──────
  {
    ck('focus_35 → start_focus 且 minutes=35',
      JSON.stringify(buildRunArgs('focus_35')) === JSON.stringify({ kind: 'action', type: 'start_focus', args: { minutes: 35 } }));
    ck('自定义专注参数被夹到 1–180',
      buildRunArgs('focus_custom', { minutes: 99999 }).args.minutes === 180
      && buildRunArgs('focus_custom', { minutes: -5 }).args.minutes === 1);
    ck('config 走 set_config.patch',
      buildRunArgs('set_interval', { interval_minutes: 20 }).args.patch.interval_minutes === 20);
    ck('config-toggle 只白名单指定键',
      JSON.stringify(buildRunArgs('set_sound', { on: true }).args.patch) === JSON.stringify({ sound_enabled: true }));
    ck('前端不能注入任意 key/type',
      JSON.stringify(buildRunArgs('set_sound', { on: true, patch: { evil: 1 }, type: 'quit' }).args.patch)
        === JSON.stringify({ sound_enabled: true }));
    ck('★ 不存在的 id 被拒', buildRunArgs('evil_quit') === null);
    ck('★ 未开放的 quit 被拒（正控：确认前不能执行）', buildRunArgs('quit_restnow') === null);
    ck('★ 未开放的 set_fullscreen 被拒', buildRunArgs('set_fullscreen', { on: true }) === null);
    ck('非法数值回落到默认值', buildRunArgs('focus_custom', { minutes: 'abc' }).args.minutes === 50);
  }

  // ── 3. 本机模式：面板 / 清单 / 动作转发 ───────────────────────
  {
    const e = fakeEngine();
    const s = await serve({ bridgePort: 47801, webLan: false }, e);
    const panel = await get(s.base + '/');
    const html = await panel.text();
    ck('GET / 返回 200 HTML', panel.status === 200 && panel.headers.get('content-type').includes('text/html'));
    ck('面板自带移动端 viewport', html.includes('viewport') && html.includes('prefers-color-scheme'));
    ck('面板不引用任何外部资源（离线可用）',
      !/<(script|link)[^>]+(src|href)=["']https?:/i.test(html));

    const feat = await (await get(s.base + '/api/features')).json();
    ck('GET /api/features 返回全量清单（含未开放的）',
      feat.ok === true && feat.features.length >= 20 && feat.groups.length >= 3);
    ck('未开放功能在清单里如实标 enabled=false',
      feat.features.find((f) => f.id === 'quit_restnow').enabled === false);

    const r1 = await (await post(s.base + '/api/run', { id: 'focus_35', values: {} })).json();
    ck('点「开始专注 35」→ 真的转发 start_focus 35',
      r1.ok === true && e.calls.some((c) => c[0] === 'action' && c[1] === 'start_focus' && c[2].minutes === 35),
      { calls: e.calls });

    const r2 = await (await post(s.base + '/api/run', { id: 'quit_restnow' }));
    ck('★ 未开放的功能返回 400 且不下发动作',
      r2.status === 400 && !e.calls.some((c) => c[1] === 'quit'));

    const r3 = await (await post(s.base + '/api/run', { id: 'nope' }));
    ck('未知 id 返回 400', r3.status === 400);

    const r4 = await (await post(s.base + '/api/run', { id: 'pet_mute', values: { on: true } })).json();
    ck('桌宠静音走 surface 而非桥动作', r4.ok === true && e.muted === true);

    const r5 = await (await post(s.base + '/api/run', { id: 'launch_restnow' })).json();
    ck('「启动歇会儿」调用 launchRestNow', r5.ok === true && e.calls.some((c) => c[0] === 'launch'));

    const health = await (await get(s.base + '/health')).json();
    ck('/health 返回状态', health.ok === true && health.version === _internal.VERSION);
    await s.close();
  }

  // ── 4. 局域网模式：口令门禁（含正控） ─────────────────────────
  {
    const e = fakeEngine();
    const s = await serve({ bridgePort: 47802, webLan: true, webToken: 's3cret-token' }, e);
    ck('面板本身不需要口令（否则没法输口令）', (await get(s.base + '/')).status === 200);

    const noTok = await get(s.base + '/api/features');
    ck('★ 无口令访问 /api/features 被拒 401', noTok.status === 401);
    const badTok = await get(s.base + '/api/features?token=wrong');
    ck('★ 错口令被拒 401', badTok.status === 401);

    const okHdr = await get(s.base + '/api/features', { 'x-restnow-token': 's3cret-token' });
    ck('正确口令（header）放行', okHdr.status === 200);
    const okQ = await get(s.base + '/api/features?token=s3cret-token');
    ck('正确口令（query，便于手机粘贴 URL）放行', okQ.status === 200);

    const noTokRun = await post(s.base + '/api/run', { id: 'rest_now' });
    ck('★ 无口令执行动作被拒，且动作没有下发',
      noTokRun.status === 401 && !e.calls.some((c) => c[1] === 'rest_now'));
    const okRun = await (await post(s.base + '/api/run', { id: 'rest_now' },
      { 'x-restnow-token': 's3cret-token' })).json();
    ck('带口令执行动作成功', okRun.ok === true && e.calls.some((c) => c[1] === 'rest_now'));

    const noTokAction = await post(s.base + '/action', { type: 'rest_now' });
    ck('★ 旧 /action 端点同样受口令保护', noTokAction.status === 401);
    await s.close();
  }

  // ── 5. 局域网未配口令时自动生成（不能裸奔） ───────────────────
  {
    const e = fakeEngine();
    const s = await serve({ bridgePort: 47803, webLan: true, webToken: '' }, e);
    const r = await get(s.base + '/api/features');
    ck('★ 局域网未配口令时自动生成、接口不再裸奔', r.status === 401);
    await s.close();
  }

  // ── 6. 本机模式不用口令（保持零摩擦） ─────────────────────────
  {
    const e = fakeEngine();
    const s = await serve({ bridgePort: 47804, webLan: false }, e);
    const r = await get(s.base + '/api/features');
    ck('本机模式免口令', r.status === 200);
    await s.close();
  }

  console.log(`\nWeb 控制台真 HTTP 冒烟：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST-CRASH', e); process.exit(2); });
