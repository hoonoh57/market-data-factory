import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npm, ['run', 'data:daily:update']);
  await run(process.execPath, [path.resolve('scripts/update-korean-equity-minute-1m.mjs'), '--skip-daily-refresh']);
  console.log('[PASS] market data update completed: daily + minute');
} catch (error) {
  console.error(`[ERROR] market data update failed: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
