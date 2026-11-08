/**
 * 排障：直接调用产品里的 `probeRestNowLaunchers()` / `resolveRestNowLauncher()`，
 * 把本机真实识别到的歇会儿启动入口打出来。只读，不启动任何程序。
 *
 * ★ 刻意**不复制** PowerShell 脚本：1.4.4 那次事故就是探针复制了一份脚本，
 *   产品改了、探针没跟上，结果「探针绿、真机红」。这里一律调产品真函数。
 *
 * 用法：node scripts/diag-launch.mjs
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { _internal } from '../lib/index.js';

const found = await _internal.probeRestNowLaunchers();
console.log('探测结果 =', JSON.stringify(found, null, 2));
for (const [k, v] of Object.entries(found)) {
  if (k !== 'APPID') console.log(`  ${k} 文件存在: ${existsSync(v)}  (${v})`);
}

// 活跃 config.json 的位置决定「安装版优先」还是「商店版优先」
const cfgPath = join(homedir(), 'AppData', 'Roaming', 'RestNow', 'config.json');
console.log('活跃 config:', cfgPath, '存在 =', existsSync(cfgPath));
const pkgDir = join(homedir(), 'AppData', 'Local', 'Packages');
let storeCfg = null;
try {
  const hit = readdirSync(pkgDir).find((d) => /^RestNow\./i.test(d));
  if (hit) storeCfg = join(pkgDir, hit, 'LocalCache', 'Roaming', 'RestNow', 'config.json');
} catch { /* 没装商店版 */ }
console.log('商店版 config:', storeCfg || '(未找到 Packages\\RestNow.*)');

for (const [tag, path] of [['安装版', cfgPath], ['商店版', storeCfg]]) {
  if (!path) continue;
  const pick = await _internal.resolveRestNowLauncher({}, path, async () => found);
  console.log(`  按「${tag}」口径会启动:`, JSON.stringify(pick));
}
const pickNow = await _internal.resolveRestNowLauncher({}, cfgPath, async () => found);
console.log(pickNow ? '\n✅ 能找到启动入口' : '\n❌ 找不到启动入口（会把「已安装」误判成「未安装」）');
process.exit(pickNow ? 0 : 1);
