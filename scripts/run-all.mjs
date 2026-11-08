// 一键全量回归：逐套跑 smoke，收集 PASS/FAIL 数字并给出总数。
// ★ 新增 smoke 必须加进 SUITES —— 否则「我跑了全量」其实少跑一套。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  'smoke-break.mjs',
  'smoke-break-guard.mjs',
  'smoke-bridge.mjs',
  'smoke-cs.mjs',
  'smoke-launch.mjs',
  'smoke-link.mjs',
  'smoke-menu.mjs',
  'smoke-web.mjs',
];

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join('scripts', file)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (c) => (out += c.toString('utf8')));
    p.stderr.on('data', (c) => (out += c.toString('utf8')));
    p.on('error', (e) => resolve({ file, rc: -1, pass: 0, fail: 1, out: String(e) }));
    p.on('exit', (rc) => {
      const m = /PASS=(\d+)\s+FAIL=(\d+)/.exec(out);
      resolve({
        file, rc, pass: m ? Number(m[1]) : 0, fail: m ? Number(m[2]) : (rc === 0 ? 0 : 1),
        out,
      });
    });
  });
}

let totalPass = 0, totalFail = 0, suitesFailed = 0;
for (const f of SUITES) {
  const r = await run(f);
  // 没有输出 PASS/FAIL 视为「脚本本身崩了」，不能被 0 分算成通过
  const parsed = /PASS=\d+\s+FAIL=\d+/.test(r.out);
  const ok = r.rc === 0 && r.fail === 0 && parsed && r.pass > 0;
  if (!ok) suitesFailed += 1;
  totalPass += r.pass;
  totalFail += r.fail;
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(24)} rc=${r.rc} PASS=${r.pass} FAIL=${r.fail}${parsed ? '' : '  (无 PASS/FAIL 输出)'}`);
  if (!ok) {
    const lines = r.out.trim().split(/\r?\n/).filter((l) => /✗|CRASH|Error|FAIL=/.test(l));
    for (const l of lines.slice(-15)) console.log('    ' + l);
  }
}
console.log(`\n全量回归：${SUITES.length} 套，通过 ${SUITES.length - suitesFailed}，失败 ${suitesFailed}，断言 PASS=${totalPass} FAIL=${totalFail}`);
process.exit(suitesFailed || totalFail ? 1 : 0);
