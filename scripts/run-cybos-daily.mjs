import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = path.join(root, 'addons', 'korean-equity-daily', 'config', 'cybos-daily.json');
const collector = path.join(root, 'addons', 'korean-equity-daily', 'collector', 'cybos_daily_32.py');
const runtimeDir = path.join(root, '.runtime', 'cybos');
const runtimeConfig = path.join(runtimeDir, 'cybos-daily.runtime.json');

if (!existsSync(baseConfig)) {
  console.error(`[ERROR] CYBOS daily config missing: ${baseConfig}`);
  process.exit(1);
}
if (!existsSync(collector)) {
  console.error(`[ERROR] CYBOS daily collector missing: ${collector}`);
  process.exit(1);
}

const request = JSON.parse(readFileSync(baseConfig, 'utf8'));
request.python32 = process.env.CYBOS_PYTHON32 || request.python32 || 'E:\\Python310-32\\python.exe';
request.outputDir = process.env.CYBOS_DAILY_STAGING_DIR || path.join(root, '.runtime', 'cybos', 'daily');
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(runtimeConfig, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

if (!existsSync(request.python32)) {
  console.error(`[ERROR] 32-bit Python not found: ${request.python32}`);
  process.exit(1);
}

const child = spawnSync(request.python32, [collector, '--request', runtimeConfig, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false,
});
if (child.error) {
  console.error(`[ERROR] unable to start CYBOS collector: ${child.error.message}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
