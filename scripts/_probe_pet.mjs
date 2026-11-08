// 找出本机正在跑的 dsh-pet 端口并 dump /state、/config 里与位置相关的字段
const http = await import('node:http');
function get(port, path) {
  return new Promise((res) => {
    const req = http.default.request({ host: '127.0.0.1', port, path: '/dsh-pet-7340' + path, timeout: 400 }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ ok: r.statusCode === 200, code: r.statusCode, body: d }));
    });
    req.on('error', () => res({ ok: false }));
    req.on('timeout', () => { req.destroy(); res({ ok: false }); });
    req.end();
  });
}
const cands = [43129];
for (let p = 43100; p <= 43250; p++) cands.push(p);
for (let p = 64000; p <= 64300; p++) cands.push(p);
for (const p of cands) {
  const r = await get(p, '/state');
  if (r.ok) {
    console.log('PET PORT =', p);
    try {
      const j = JSON.parse(r.body);
      const dump = (label, o) => {
        if (!o) return console.log(label, 'null');
        const out = {};
        for (const k of ['pets','position','size','corner','marginX','marginY']) {
          if (o[k] !== undefined) out[k] = o[k];
        }
        console.log(label, JSON.stringify(out).slice(0, 800));
      };
      console.log('--- /state (pets) ---');
      console.log(JSON.stringify(j.pets || j, null, 1).slice(0, 1500));
      const cfg = await get(p, '/config');
      if (cfg.ok) {
        const c = JSON.parse(cfg.body);
        console.log('--- /config (main.pets[].position) ---');
        const pets = (c.main && c.main.pets) || [];
        for (const pet of pets) console.log(JSON.stringify(pet.position), 'size=', pet.size, 'id=', pet.id);
      }
    } catch (e) { console.log('parse err', e.message, r.body.slice(0,200)); }
    break;
  }
}
console.log('done');
