/**
 * 歇会儿 × 桌宠 Web 控制台：功能清单 + 单文件面板。
 *
 * 清单来源 = 产品侧 restnow_bridge_host.py::_handle_action 的全部 8 类动作
 * （snooze / unsnooze / start_focus / toggle_pause / rest_now / ack_rest /
 *  set_config / quit）+ 插件自身的能力（静音 / 模拟 / 重连 / 状态）。
 * ★ 清单是**数据驱动**的：用户确认「哪些功能要做」只需改本文件的 enabled，
 *   不需要动服务端逻辑。前端只能传 feature.id，不能注入任意 type。
 */

export const WEB_FEATURE_GROUPS = ['休息与专注', '设置', '桌宠与插件', '诊断'];

export const WEB_FEATURES = [
  // ── 休息与专注 ──────────────────────────────────────────────
  { id: 'rest_now', group: '休息与专注', label: '立即休息', desc: '立刻弹出休息提醒', kind: 'action', type: 'rest_now', enabled: true },
  { id: 'ack_rest', group: '休息与专注', label: '我歇好了', desc: '关闭当前休息弹窗，让桌宠归位', kind: 'action', type: 'ack_rest', enabled: true },
  { id: 'focus_25', group: '休息与专注', label: '开始专注 25 分钟', desc: '把下次提醒挪到 25 分钟后', kind: 'action', type: 'start_focus', args: { minutes: 25 }, enabled: true },
  { id: 'focus_35', group: '休息与专注', label: '开始专注 35 分钟', desc: '把下次提醒挪到 35 分钟后', kind: 'action', type: 'start_focus', args: { minutes: 35 }, enabled: true },
  { id: 'focus_45', group: '休息与专注', label: '开始专注 45 分钟', desc: '把下次提醒挪到 45 分钟后', kind: 'action', type: 'start_focus', args: { minutes: 45 }, enabled: true },
  { id: 'focus_custom', group: '休息与专注', label: '自定义专注时长', desc: '1–180 分钟', kind: 'action', type: 'start_focus',
    params: [{ key: 'minutes', label: '分钟', def: 50, min: 1, max: 180 }], enabled: true },
  { id: 'snooze_5', group: '休息与专注', label: '延后 5 分钟', desc: '晚 5 分钟再提醒', kind: 'action', type: 'snooze', args: { minutes: 5 }, enabled: true },
  { id: 'snooze_custom', group: '休息与专注', label: '自定义延后', desc: '1–240 分钟', kind: 'action', type: 'snooze',
    params: [{ key: 'minutes', label: '分钟', def: 15, min: 1, max: 240 }], enabled: true },
  { id: 'unsnooze', group: '休息与专注', label: '取消延后', desc: '立刻重新开始计时', kind: 'action', type: 'unsnooze', enabled: true },
  { id: 'toggle_pause', group: '休息与专注', label: '暂停 / 恢复提醒', desc: '切换提醒开关', kind: 'action', type: 'toggle_pause', enabled: true },

  // ── 设置（set_config 的白名单键，与 host 一致） ───────────────
  { id: 'set_interval', group: '设置', label: '提醒间隔', desc: '1–600 分钟', kind: 'config',
    params: [{ key: 'interval_minutes', label: '分钟', def: 45, min: 1, max: 600 }], enabled: true },
  { id: 'set_popup_sec', group: '设置', label: '弹窗时长', desc: '5–3600 秒', kind: 'config',
    params: [{ key: 'popup_duration_seconds', label: '秒', def: 30, min: 5, max: 3600 }], enabled: true },
  { id: 'set_fullscreen', group: '设置', label: '全屏弹窗', desc: '开/关全屏休息界面', kind: 'config-toggle', key: 'fullscreen_popup', enabled: false },
  { id: 'set_force_rest', group: '设置', label: '强制休息', desc: '开/关强制休息', kind: 'config-toggle', key: 'force_rest', enabled: false },
  { id: 'set_sound', group: '设置', label: '提醒声音', desc: '开/关声音', kind: 'config-toggle', key: 'sound_enabled', enabled: true },
  { id: 'set_work_hours', group: '设置', label: '仅工作时段提醒', desc: '开/关工作时段限制', kind: 'config-toggle', key: 'work_hours_enabled', enabled: false },

  // ── 桌宠与插件 ──────────────────────────────────────────────
  { id: 'pet_mute', group: '桌宠与插件', label: '桌宠静音', desc: '开/关桌宠台词与动作', kind: 'surface', surface: 'mute', enabled: true },
  { id: 'pet_seat', group: '桌宠与插件', label: '让鱼坐到旁边', desc: '重新落座到当前窗口旁', kind: 'surface', surface: 'seat', enabled: true },
  { id: 'pet_home', group: '桌宠与插件', label: '让鱼回家', desc: '回到配置停靠角', kind: 'surface', surface: 'home', enabled: true },
  { id: 'reconnect', group: '桌宠与插件', label: '强制重连', desc: '桥没反应时点一下', kind: 'surface', surface: 'reconnect', enabled: true },
  { id: 'launch_restnow', group: '桌宠与插件', label: '启动歇会儿', desc: '没开时自动拉起', kind: 'surface', surface: 'launch', enabled: true },

  // ── 诊断 ────────────────────────────────────────────────────
  { id: 'sim_break', group: '诊断', label: '模拟一次休息', desc: '测试桌宠联动（4 秒后收窗）', kind: 'surface', surface: 'sim-break', enabled: true },
  { id: 'sim_pomo', group: '诊断', label: '模拟番茄完成', desc: '测试番茄钟动作', kind: 'surface', surface: 'sim-pomo', enabled: true },
  { id: 'quit_restnow', group: '诊断', label: '退出歇会儿', desc: '⚠️ 会关闭主程序', kind: 'action', type: 'quit', danger: true, enabled: false },
];

/** 供前端渲染的纯数据（不含任何可执行内容）。 */
export function publicFeatures() {
  return WEB_FEATURES.map((f) => ({
    id: f.id, group: f.group, label: f.label, desc: f.desc,
    danger: Boolean(f.danger), enabled: Boolean(f.enabled),
    params: f.params || [],
    // 用「开启 / 关闭」双按钮而不是单个执行按钮
    toggle: f.kind === 'config-toggle' || f.id === 'pet_mute',
  }));
}

/**
 * 把「功能 id + 前端输入」翻译成歇会儿的动作。
 * 白名单：只认 WEB_FEATURES 里的 id，且 enabled=false 的一律拒绝 ——
 * 前端不能绕过确认结果偷偷启用未开放的能力。
 */
export function buildRunArgs(id, values = {}) {
  const f = WEB_FEATURES.find((x) => x.id === id);
  if (!f || !f.enabled) return null;
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const pick = (params) => {
    const out = {};
    for (const p of params || []) out[p.key] = num(values[p.key], p.def, p.min, p.max);
    return out;
  };
  if (f.kind === 'action') {
    return { kind: 'action', type: f.type, args: { ...(f.args || {}), ...pick(f.params) } };
  }
  if (f.kind === 'config') {
    return { kind: 'action', type: 'set_config', args: { patch: pick(f.params) } };
  }
  if (f.kind === 'config-toggle') {
    const on = values.on === true || values.on === '1' || values.on === 1;
    return { kind: 'action', type: 'set_config', args: { patch: { [f.key]: on } } };
  }
  if (f.kind === 'surface') {
    const on = values.on === true || values.on === '1' || values.on === 1;
    return { kind: 'surface', surface: f.surface, on };
  }
  return null;
}

/** 面板：单文件、无外部依赖、移动端可用。设计令牌集中在 :root，全程只引用令牌。 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>歇会儿 · 控制台</title>
<style>
:root{
  --sp-sm:8px; --sp-md:16px; --sp-lg:24px;
  --r:12px; --r-sm:8px;
  --bg:#f4f6f9; --surface:#fff; --primary:#006DA0; --primary-weak:#e8f3f9;
  --text:#1b2430; --muted:#6b7785; --border:#e3e9f0; --danger:#c0392b;
  --shadow:0 1px 2px rgba(16,32,48,.05),0 6px 18px rgba(16,32,48,.05);
  --fs-title:20px; --fs-h:13px; --fs-body:14px; --fs-tip:12px; --lh:1.5;
  --h-btn:40px; --h-input:36px;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#141a21;--surface:#1d252e;--primary:#4db3e0;--primary-weak:#1b3441;
    --text:#e8eef5;--muted:#93a1b0;--border:#2b3642;
    --shadow:0 1px 2px rgba(0,0,0,.2),0 6px 18px rgba(0,0,0,.18);}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:var(--fs-body)/var(--lh) -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:var(--sp-lg) var(--sp-md) calc(var(--sp-lg)*2)}
header{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-md);
  margin-bottom:var(--sp-lg);flex-wrap:wrap}
h1{margin:0;font-size:var(--fs-title);font-weight:650;letter-spacing:.2px}
.sub{font-size:var(--fs-tip);color:var(--muted);margin-top:2px}
.status{display:flex;align-items:center;gap:var(--sp-sm);font-size:var(--fs-tip);
  color:var(--muted);background:var(--surface);border:1px solid var(--border);
  border-radius:999px;padding:6px 12px;box-shadow:var(--shadow)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:0 0 auto}
.dot.ok{background:#2e9e6b}.dot.bad{background:var(--danger)}
section{margin-bottom:var(--sp-lg)}
h2{font-size:var(--fs-h);font-weight:650;color:var(--muted);letter-spacing:.6px;
  margin:0 0 var(--sp-sm);text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:var(--sp-md)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:var(--sp-md);box-shadow:var(--shadow);display:flex;flex-direction:column;gap:var(--sp-sm)}
.card .label{font-weight:600;font-size:var(--fs-body)}
.card .desc{font-size:var(--fs-tip);color:var(--muted);min-height:calc(var(--fs-tip)*var(--lh)*2)}
.card .row{display:flex;gap:var(--sp-sm);align-items:center;margin-top:auto}
input[type=number]{width:100%;height:var(--h-input);padding:0 10px;background:var(--bg);
  color:var(--text);border:1px solid var(--border);border-radius:var(--r-sm);font-size:var(--fs-body)}
button{height:var(--h-btn);padding:0 14px;flex:1;border:1px solid var(--border);
  border-radius:var(--r-sm);background:var(--primary-weak);color:var(--primary);
  font-size:var(--fs-body);font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{filter:brightness(.96)}button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:default}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.toggle{display:flex;gap:var(--sp-sm)}.toggle button{flex:1}
.toast{position:fixed;left:50%;bottom:var(--sp-lg);transform:translateX(-50%);
  background:var(--text);color:var(--surface);padding:10px 18px;border-radius:999px;
  font-size:var(--fs-tip);box-shadow:var(--shadow);opacity:0;pointer-events:none;
  transition:opacity .2s;max-width:90vw;text-align:center;z-index:9}
.toast.show{opacity:1}
.gate{max-width:360px;margin:12vh auto;padding:var(--sp-lg);background:var(--surface);
  border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);text-align:center}
.gate p{color:var(--muted);font-size:var(--fs-tip)}
.gate input{margin-bottom:var(--sp-md);height:var(--h-input);text-align:center}
@media(max-width:560px){.wrap{padding:var(--sp-md) var(--sp-sm) calc(var(--sp-lg)*2)}
  .grid{grid-template-columns:1fr}.status{width:100%;justify-content:center}}
.tut{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:var(--sp-md);box-shadow:var(--shadow);margin-bottom:var(--sp-lg)}
.tut>summary{cursor:pointer;font-weight:650;font-size:var(--fs-body);color:var(--text);
  list-style:none;display:flex;align-items:center;gap:var(--sp-sm);margin:0}
.tut>summary::-webkit-details-marker{display:none}
.tut>summary::before{content:"▸";color:var(--primary);transition:transform .15s;font-size:12px}
.tut[open]>summary::before{transform:rotate(90deg)}
.tut>summary:focus-visible{outline:2px solid var(--primary);outline-offset:4px;border-radius:var(--r-sm)}
.tut h3{font-size:var(--fs-body);font-weight:650;margin:var(--sp-md) 0 var(--sp-sm);color:var(--text)}
.tut p,.tut li{font-size:var(--fs-tip);color:var(--muted);line-height:var(--lh);margin:0 0 var(--sp-sm)}
.tut ol,.tut ul{padding-left:18px;margin:0 0 var(--sp-sm)}
.tut b{color:var(--text)}
.tut code{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:1px 5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--text)}
.tut pre{background:var(--bg);border:1px solid var(--border);border-radius:var(--r-sm);
  padding:var(--sp-sm);overflow:auto;margin:0 0 var(--sp-md)}
.tut pre code{background:none;border:none;padding:0;font-size:11px;line-height:1.45;
  white-space:pre;color:var(--text)}
.tut .warn{background:var(--primary-weak);border:1px solid var(--primary);border-radius:var(--r-sm);
  padding:var(--sp-sm);font-size:var(--fs-tip);color:var(--text);margin:0 0 var(--sp-md)}
.tut .warn b{color:var(--danger)}
.tut table{width:100%;border-collapse:collapse;font-size:var(--fs-tip);margin:0 0 var(--sp-md)}
.tut th,.tut td{border:1px solid var(--border);padding:4px 8px;text-align:left;color:var(--muted)}
.tut th{background:var(--bg);color:var(--text);font-weight:600}
</style>
</head>
<body>
<div id="gate" class="gate" hidden>
  <h1>需要访问口令</h1>
  <p>局域网访问需要口令，见 DSH 的 harness.log 里带 token 的网址。</p>
  <input id="gateToken" type="password" placeholder="访问口令" autocomplete="off">
  <button id="gateOk" style="width:100%">进入</button>
</div>

<div class="wrap" id="main">
  <header>
    <div><h1>歇会儿 · 控制台</h1><div class="sub">点一下就执行，手机和电脑都能用</div></div>
    <div class="status"><span class="dot" id="dot"></span><span id="statusText">连接中…</span></div>
  </header>

  <details class="tut">
    <summary>手机控制 / 自己加功能教程</summary>

    <h3>一、用手机控制（同一 WiFi）</h3>
    <p>本面板本就是响应式，手机浏览器打开就能用。但默认只绑本机 <code>127.0.0.1</code>，手机连不上，需先开局域网访问：</p>
    <ol>
      <li>打开局域网：编辑插件目录的 <code>cordis.patch.yml</code>，在 <code>config:</code> 块下加一行 <code>webLan: true</code>（或在 DSH 插件配置 UI 加同名键）。</li>
      <li><b>完全退出 DSH</b>（托盘右键退出，不是关窗口），再重开让配置生效。</li>
      <li>打开后看 DSH 的 <code>harness.log</code>，里面会打印带口令的局域网网址，形如 <code>http://192.168.x.x:47110/?token=xxxx</code>。手机和电脑连同一 WiFi，用手机浏览器打开它即可。</li>
      <li>想固定口令：在 <code>config</code> 里加 <code>webToken: '你的固定串'</code>；不填则每次启动自动生成新 token，旧网址会失效。</li>
    </ol>
    <div class="warn"><b>安全：</b><code>webLan: true</code> 会把控制台暴露给同网段任何人。token 是必填访问口令（防别人蹭控你的电脑），<b>只在可信 WiFi 下开启</b>，用完建议改回 <code>webLan: false</code>。</div>

    <h3>二、自己加功能按钮（改数据，不动逻辑）</h3>
    <p>页面上所有按钮都来自插件源码 <code>lib/web-panel.js</code> 里的 <code>WEB_FEATURES</code> 数组，是<b>纯数据驱动</b>的：前端只发送功能 <code>id</code>，服务端按白名单校验，不认识的 <code>id</code> 一律拒绝。所以加一个按钮 = 往数组里加一项，重启 DSH（或重开面板）就生效。</p>
    <p>直接抄下面任意一条，粘到 <code>WEB_FEATURES</code> 数组末尾（每项之间用逗号分隔）：</p>
    <pre><code>// 例1：复用已有动作（立即休息 + 设 30 分钟专注）
{ id:'rest_focus30', group:'休息与专注', label:'休息并专注30分',
  desc:'立刻休息，下次提醒挪到30分钟后', kind:'action',
  type:'start_focus', args:{ minutes:30 }, enabled:true },

// 例2：带参数的设置（自定义提醒间隔）
{ id:'set_interval_diy', group:'设置', label:'提醒间隔(自定义)',
  desc:'5–600 分钟', kind:'config',
  params:[{ key:'interval_minutes', label:'分钟', def:45, min:5, max:600 }], enabled:true },

// 例3：插件自身能力（让桌宠回家）
{ id:'pet_home_diy', group:'桌宠与插件', label:'让鱼回家',
  desc:'回到配置停靠角', kind:'surface', surface:'home', enabled:true },</code></pre>
    <p>字段含义：</p>
    <table>
      <tr><th>字段</th><th>说明</th></tr>
      <tr><td>id</td><td>唯一标识，前端只发它；别和已有项重复</td></tr>
      <tr><td>group</td><td>所属分组，必须是这四者之一：休息与专注 / 设置 / 桌宠与插件 / 诊断</td></tr>
      <tr><td>kind</td><td>action（转发给歇会儿）/ config（改设置）/ config-toggle（开关）/ surface（插件自身能力）</td></tr>
      <tr><td>type</td><td>kind=action 时填歇会儿动作名：rest_now / start_focus / snooze / toggle_pause / ack_rest / quit</td></tr>
      <tr><td>args</td><td>kind=action 时的固定参数，如 { minutes:30 }</td></tr>
      <tr><td>surface</td><td>kind=surface 时填 mute / seat / home / launch / reconnect / sim-break / sim-pomo</td></tr>
      <tr><td>params</td><td>需用户输入的参数，如 [{ key:'minutes', label:'分钟', def:45, min:1, max:600 }]</td></tr>
      <tr><td>key</td><td>kind=config-toggle 时填要切换的设置键，如 fullscreen_popup</td></tr>
      <tr><td>enabled</td><td>是否开放；false 则前端不显示、服务端也拒绝</td></tr>
      <tr><td>danger</td><td>true 时按钮变红并要求二次确认，用于退出等危险操作</td></tr>
    </table>

    <h3>三、进阶：触发别的系统（自定义 HTTP / 脚本）</h3>
    <p>上面四类只覆盖歇会儿桥动作和插件自身能力。要调用你自己的接口（智能家居、Webhook、本地脚本），需扩展两处源码。下面是可直接粘贴的实现：</p>
    <p><b>1) lib/web-panel.js</b> 的 <code>WEB_FEATURES</code> 加一项（URL 写死在源码里，前端不能改）：</p>
    <pre><code>{ id:'my_webhook', group:'诊断', label:'调用我的接口',
  desc:'POST 到指定地址', kind:'http',
  method:'POST', url:'http://127.0.0.1:8080/hook', enabled:true },</code></pre>
    <p><b>2) lib/web-panel.js</b> 的 <code>buildRunArgs</code> 末尾（default 返回 null 之前）放行：</p>
    <pre><code>  if (f.kind === 'http') {
    return { kind:'http', method: f.method || 'GET', url: f.url, body: f.body };
  }</code></pre>
    <p><b>3) lib/index.js</b> 的 <code>runWebFeature</code> 加一个分支（在 <code>if (s === 'sim-pomo')</code> 之后）：</p>
    <pre><code>  if (spec.kind === 'http') {
    try {
      const r = await fetch(spec.url, {
        method: spec.method || 'GET',
        headers: spec.body ? { 'Content-Type':'application/json' } : undefined,
        body: spec.body ? JSON.stringify(spec.body) : undefined,
      });
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok:false, error: String(e && e.message ? e.message : e) }; }
  }</code></pre>
    <div class="warn"><b>安全红线：</b>这类扩展等于让网页能触发服务端请求 / 命令。<b>务必保留 token 校验</b>（LAN 默认已强制），且 <code>url</code> / <code>cmd</code> 只能写死在源码里、绝不让前端传。脚本执行（child_process）风险更高，仅限完全可信的本机环境，绝不要暴露到不可信网络。</div>
  </details>

  <div id="groups"></div>
</div>
<div class="toast" id="toast"></div>

<script>
(function(){
  var q=new URLSearchParams(location.search);
  var token=q.get('token')||sessionStorage.getItem('rn_token')||'';
  if(q.get('token'))sessionStorage.setItem('rn_token',q.get('token'));
  var $=function(id){return document.getElementById(id)};
  var toastTimer=null;
  function toast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');
    clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.classList.remove('show')},2600)}
  function api(path,opt){
    opt=opt||{};opt.headers=opt.headers||{};
    if(token)opt.headers['X-RestNow-Token']=token;
    if(opt.body){opt.headers['Content-Type']='application/json';opt.method='POST'}
    return fetch(path,opt).then(function(r){
      if(r.status===401){$('gate').hidden=false;$('main').hidden=true;throw new Error('unauthorized')}
      return r.json()});
  }
  $('gateOk').onclick=function(){
    token=$('gateToken').value.trim();sessionStorage.setItem('rn_token',token);
    $('gate').hidden=true;$('main').hidden=false;load()};
  $('gateToken').onkeydown=function(e){if(e.key==='Enter')$('gateOk').click()};

  function refreshStatus(){
    api('/health').then(function(s){
      var ok=!!(s.ok&&s.bridge&&(s.bridge.connected||s.bridge.available));
      $('dot').className='dot '+(ok?'ok':'bad');
      $('statusText').textContent=(s.version||'插件')+' · '+(ok?'歇会儿已连接':'歇会儿未连接');
    }).catch(function(){$('dot').className='dot bad';$('statusText').textContent='连接失败'});
  }

  function card(f){
    var d=document.createElement('div');d.className='card';
    var l=document.createElement('div');l.className='label';l.textContent=f.label;
    var p=document.createElement('div');p.className='desc';p.textContent=f.desc;
    d.appendChild(l);d.appendChild(p);
    var inputs={};
    if(f.params&&f.params.length){
      f.params.forEach(function(pm){
        var i=document.createElement('input');i.type='number';i.value=pm.def;
        i.min=pm.min;i.max=pm.max;i.setAttribute('aria-label',pm.label);
        inputs[pm.key]=i;d.appendChild(i)});
    }
    var row=document.createElement('div');row.className='row';
    function run(values){
      var btn=row.querySelector('button');if(btn)btn.disabled=true;
      api('/api/run',{body:JSON.stringify({id:f.id,values:values||{}})})
        .then(function(r){toast(r&&r.ok?'已执行：'+f.label:'未执行：'+((r&&(r.error||r.message))||'无响应'));refreshStatus()})
        .catch(function(e){if(e.message!=='unauthorized')toast('请求失败：'+e.message)})
        .then(function(){if(btn)btn.disabled=false});
    }
    if(f.toggle){
      var on=document.createElement('button');on.textContent='开启';
      var off=document.createElement('button');off.textContent='关闭';
      on.onclick=function(){run({on:true})};off.onclick=function(){run({on:false})};
      row.appendChild(on);row.appendChild(off);row.className='row toggle';
    }else{
      var b=document.createElement('button');b.textContent=f.danger?'确认退出':'执行';
      if(f.danger)b.className='danger';
      b.onclick=function(){var v={};(f.params||[]).forEach(function(pm){v[pm.key]=inputs[pm.key].value});
        if(f.danger&&!confirm('确定要退出歇会儿吗？'))return;run(v)};
      row.appendChild(b);
    }
    d.appendChild(row);return d;
  }

  function load(){
    api('/api/features').then(function(data){
      var groups=data.groups||[],list=(data.features||[]).filter(function(f){return f.enabled});
      $('groups').innerHTML='';
      groups.forEach(function(g){
        var items=list.filter(function(f){return f.group===g});if(!items.length)return;
        var sec=document.createElement('section');var h=document.createElement('h2');h.textContent=g;
        var grid=document.createElement('div');grid.className='grid';
        items.forEach(function(f){grid.appendChild(card(f))});
        sec.appendChild(h);sec.appendChild(grid);$('groups').appendChild(sec);
      });
      refreshStatus();setInterval(refreshStatus,10000);
    }).catch(function(e){if(e.message!=='unauthorized')toast('加载功能失败：'+e.message)});
  }
  load();
})();
</script>
</body>
</html>`;
