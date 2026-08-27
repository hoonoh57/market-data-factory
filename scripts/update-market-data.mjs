import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

function runNodeScript(script, args = []) {
  return run(process.execPath, [path.resolve(script), ...args]);
}

async function runDailyUpdate() {
  // Avoid direct npm.cmd spawning from Node on Windows (EINVAL on newer Node).
  // These are exactly the three stages behind data:daily:update.
  await runNodeScript('scripts/run-cybos-daily.mjs');
  await runNodeScript('scripts/import-korean-equity-daily.mjs');
  await runNodeScript('scripts/check-korean-equity-daily.mjs');
}

try {
  await runDailyUpdate();
  await runNodeScript('scripts/update-korean-equity-minute-1m.mjs', ['--skip-daily-refresh']);
  await runNodeScript('scripts/update-korean-market-index.mjs', ['--skip-daily-refresh']);
  console.log('[PASS] market data update completed: daily + minute + market-index');
} catch (error) {
  console.error(`[ERROR] market data update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
